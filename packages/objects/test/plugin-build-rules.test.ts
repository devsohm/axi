import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import { createHost, defineFacet, defineRegistry } from "../src/index.ts";
import * as objects from "../src/index.ts";
import { buildFacet, discoverPlugins, evaluateFacet } from "../src/node/plugins/index.ts";
import type { BuildOptions } from "../src/node/plugins/build.ts";

async function fixture(files: Readonly<Record<string, string>>, manifest = {}) {
	const root = await mkdtemp(join(tmpdir(), "axi-plugin-rules-"));
	const dir = join(root, "meter");
	await mkdir(dir);
	await writeFile(join(dir, "package.json"), JSON.stringify({ name: "meter", type: "module", ...manifest }));
	for (const [path, content] of Object.entries(files)) {
		const file = join(dir, path);
		await mkdir(dirname(file), { recursive: true });
		await writeFile(file, content);
	}
	const discovered = await discoverPlugins([root], { kinds: ["server", "web", "worker"] }, context);
	expect(discovered.problems).toEqual([]);
	const plugin = discovered.plugins.find((item) => item.name === "meter");
	if (!plugin) throw new Error("Plugin was not discovered");
	return {
		root,
		dir,
		plugin,
		async [Symbol.asyncDispose]() {
			await rm(root, { recursive: true, force: true });
		},
	};
}
const node: BuildOptions = { platform: "node", hostPackages: [], kinds: ["server", "web", "worker"] };

test.each([
	["export default {setup(){return import('./helper.ts')}}", "has no dynamic import"],
	["await Promise.resolve(); export default {setup(){}}", "has no top-level await"],
	["export default {setup(){return __dirname}}", "__dirname and __filename are not available"],
	["export default {setup(){return __filename}}", "__dirname and __filename are not available"],
	["export default {setup(){return import.meta.url}}", "import.meta.url"],
	[
		"import value from 'undeclared'; export default {setup(){return value}}",
		"neither a host package nor in the dependencies",
	],
	["import path from './icon.svg?url'; export default {setup(){return path}}", "assets by URL are for browser builds"],
])("invalid plugin code reports the source error: %s", async (source, expected) => {
	await using f = await fixture({ "server.ts": source, "helper.ts": "export default 7", "icon.svg": "<svg/>" });
	const built = await buildFacet(f.plugin, "server", node, context);
	expect(built).toMatchObject({ kind: "failed", plugin: "meter", errors: [expect.stringContaining(expected)] });
	const repaired = "export default {setup(){}}";
	await writeFile(join(f.dir, "server.ts"), repaired);
	expect(await buildFacet(f.plugin, "server", node, context)).toMatchObject({ kind: "script" });
});

test.each([
	["@axi/objects", "plugins import Objects through the app's API"],
	["@example/api", "import a version"],
	["@example/api/v3", "is not available"],
	["@example/api/v1/web", "not available to server facets"],
])("application API boundaries reject %s", async (specifier, expected) => {
	await using f = await fixture({
		"server.ts": `import {value} from ${JSON.stringify(specifier)}; export default {setup(){return value;}}`,
	});
	expect(
		await buildFacet(
			f.plugin,
			"server",
			{
				...node,
				api: { name: "@example/api", versions: ["v1", "v2"] },
				hostPackages: ["@example/api/v1", "@example/api/v2"],
			},
			context,
		),
	).toMatchObject({ kind: "failed", errors: [expect.stringContaining(expected)] });
});

test("a facet cannot combine two versions of the application API", async () => {
	await using f = await fixture({
		"server.ts":
			"import {a} from '@example/api/v1'; import {b} from '@example/api/v2'; export default {setup(){return [a,b];}}",
	});
	expect(
		await buildFacet(
			f.plugin,
			"server",
			{
				...node,
				api: { name: "@example/api", versions: ["v1", "v2"] },
				hostPackages: ["@example/api/v1", "@example/api/v2"],
			},
			context,
		),
	).toMatchObject({ kind: "failed", errors: [expect.stringContaining("one facet imports one version")] });
});

test("cross-kind imports report the full chain and shared source remains usable", async () => {
	await using f = await fixture({
		"server.ts": "import value from './helpers/shared.ts'; export default {setup(){return value;}}",
		"helpers/shared.ts": "export {default} from '../web.ts';",
		"web.ts": "export default 7;",
	});
	expect(await buildFacet(f.plugin, "server", node, context)).toMatchObject({
		kind: "failed",
		errors: [expect.stringContaining("a web file, imported into a server facet")],
	});
	await writeFile(join(f.dir, "helpers/shared.ts"), "export default 7;");
	expect(await buildFacet(f.plugin, "server", node, context)).toMatchObject({ kind: "script" });
	expect(await buildFacet(f.plugin, "worker", node, context)).toMatchObject({
		kind: "failed",
		errors: [expect.stringContaining("has no worker facet")],
	});
});

test("an extensionless shared source can have the name of another facet kind", async () => {
	await using f = await fixture({
		"server.ts": "import value from './web'; export default {setup(){return value;}}",
		"web": "export default 7;",
	});
	expect(await buildFacet(f.plugin, "server", node, context)).toMatchObject({ kind: "script" });
});

test("a symlinked entry cannot leave its plugin or masquerade as another facet kind", async () => {
	await using f = await fixture({ "server.ts": "export default {setup(){}}", "web.ts": "export default {setup(){}}" });
	await rm(join(f.dir, "server.ts"));
	await symlink("web.ts", join(f.dir, "server.ts"));
	expect(await buildFacet(f.plugin, "server", node, context)).toMatchObject({
		kind: "failed",
		errors: [expect.stringContaining("links to a web file")],
	});
	await rm(join(f.dir, "server.ts"));
	await writeFile(join(f.root, "outside.ts"), "export default {setup(){}}");
	await symlink("../outside.ts", join(f.dir, "server.ts"));
	expect(await buildFacet(f.plugin, "server", node, context)).toMatchObject({
		kind: "failed",
		errors: [expect.stringContaining("links out of its plugin")],
	});
});

test("Node builtins are available to Node plugins and rejected in browser plugins", async () => {
	const Result = defineRegistry<string, string[]>("test.build-result", { version: 1 });
	await using f = await fixture({
		"server.ts":
			"import {defineFacet,Result} from '@test/host'; import {basename} from 'node:path'; export default defineFacet((_host,self)=>self.contribute(Result,basename('/path/leaf')));",
	});
	const hostPackages = { "@test/host": { ...objects, Result } };
	const built = await buildFacet(f.plugin, "server", { ...node, hostPackages: Object.keys(hostPackages) }, context);
	if (built.kind !== "script") throw new Error(built.errors.join("\n"));
	const host = createHost({ onError() {} });
	try {
		await host.load(
			[
				{
					name: "result",
					facet: defineFacet((h) => h.serve(Result, { compose: (entries) => entries.map((entry) => entry.value) })),
				},
				{ name: f.plugin.name, facet: evaluateFacet(built, { plugin: f.plugin, hostPackages }) },
			],
			context,
		);
		expect((await host.registry(Result, context)).value).toEqual(["leaf"]);
	} finally {
		await host.close(context);
	}
	expect(
		await buildFacet(
			f.plugin,
			"server",
			{ ...node, platform: "browser", hostPackages: Object.keys(hostPackages) },
			context,
		),
	).toMatchObject({ kind: "failed", errors: [expect.stringContaining("Node builtin in a browser build")] });
});

test("declared dependencies bundle ordinary cross-kind filenames but reject a dependency's declared facet kind", async () => {
	await using f = await fixture(
		{
			"server.ts": "import value from 'dependency'; export default {setup(){return value}}",
			"node_modules/dependency/package.json": JSON.stringify({ name: "dependency", main: "web.js" }),
			"node_modules/dependency/web.js": "module.exports = 7;",
		},
		{ dependencies: { dependency: "1.0.0" } },
	);
	expect(await buildFacet(f.plugin, "server", node, context)).toMatchObject({ kind: "script" });
	await writeFile(
		join(f.dir, "node_modules/dependency/package.json"),
		JSON.stringify({ name: "dependency", main: "web.js", objects: {} }),
	);
	expect(await buildFacet(f.plugin, "server", node, context)).toMatchObject({
		kind: "failed",
		errors: [expect.stringContaining("a web file, imported into a server facet")],
	});
});

test("copies from a sibling plugin stay within that sibling and record each copied source", async () => {
	await using f = await fixture({
		"server.ts": "import value from '../sibling/shared.ts'; export default {setup(){return value}}",
	});
	await mkdir(join(f.root, "sibling"));
	await writeFile(join(f.root, "sibling/package.json"), JSON.stringify({ name: "sibling", type: "module" }));
	await writeFile(join(f.root, "sibling/shared.ts"), "export {default} from './value.ts';");
	await writeFile(join(f.root, "sibling/value.ts"), "export default 7;");
	const discovery = await discoverPlugins([f.root], { kinds: ["server", "web"] }, context);
	const built = await buildFacet(f.plugin, "server", { ...node, plugins: discovery.plugins }, context);
	expect(built).toMatchObject({
		kind: "script",
		copied: [join(f.root, "sibling/shared.ts"), join(f.root, "sibling/value.ts")],
	});
	await writeFile(join(f.root, "sibling/value.ts"), "import value from '../meter/helper.ts'; export default value;");
	await writeFile(join(f.dir, "helper.ts"), "export default 9;");
	expect(await buildFacet(f.plugin, "server", { ...node, plugins: discovery.plugins }, context)).toMatchObject({
		kind: "failed",
		errors: [expect.stringContaining("may import only host packages and files of its own plugin")],
	});
});
