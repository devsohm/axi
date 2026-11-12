import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import * as api from "../src/index.ts";
import { buildFacet, createPlugins, discoverPlugins, evaluateFacet, mapStack } from "../src/node/plugins/index.ts";
import { PluginWatcher } from "../src/node/plugins/watcher.ts";
import { Batch } from "../src/state/internal.ts";

const packages = { "@axi/objects": api };
const Metric = api.local("plugin.metric", { version: 1, params: {}, members: { reading: api.int() } });
const source = (reading: number) => `import {defineFacet,local,int,constant} from "@axi/objects";
const Metric=local("plugin.metric",{version:1,params:{},members:{reading:int()}});
export default defineFacet(host=>host.serve(Metric,()=>({reading:constant(${reading})})));`;

it("releases the build of a removed plugin while its loader remains alive", () => {
	execFileSync(
		process.execPath,
		["--expose-gc", fileURLToPath(new URL("./fixtures/removed-plugin-build.mjs", import.meta.url))],
		{ timeout: 10000 },
	);
});

it("uses one public asset address from the options for each build", async () => {
	const root = await mkdtemp(join(tmpdir(), "axi-plugin-assets-"));
	await fixture(root, {
		"icon.svg": "<svg/>",
		"web.ts": 'import icon from "./icon.svg?url"; export default {setup(){return icon;}};',
	});
	let reads = 0;
	const plugins = createPlugins(
		{
			roots: [root],
			kinds: { web: { platform: "browser", hostPackages: [] } },
			get publicPath() {
				return `/assets-${++reads}/`;
			},
			onError: () => {},
		},
		context,
	);
	try {
		const built = await plugins.build(["meter"], context);
		const facet = built.facets[0];
		if (facet.kind === "failed") throw new Error(facet.errors.join("\n"));
		expect(reads).toBe(1);
		expect(facet.source).toContain("/assets-1/");
	} finally {
		plugins.close();
		await rm(root, { recursive: true, force: true });
	}
});

async function fixture(root: string, files: Readonly<Record<string, string>>): Promise<string> {
	const dir = join(root, "meter");
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "package.json"), JSON.stringify({ name: "meter", type: "module" }));
	for (const [name, contents] of Object.entries(files)) await writeFile(join(dir, name), contents);
	return dir;
}

it.each(["directory", "manifest", "facet"] as const)(
	"reloads a removed %s and a new plugin before file events arrive",
	async (removed) => {
		const root = await mkdtemp(join(tmpdir(), "axi-plugin-discovery-"));
		const dir = await fixture(root, { "worker.ts": source(1) });
		const plugins = createPlugins(
			{ roots: [root], kinds: { worker: { platform: "node", hostPackages: Object.keys(packages) } }, onError() {} },
			context,
		);
		const host = api.createHost({ onError() {} });
		try {
			await plugins.load(host, { kind: "worker", core: [], modules: packages }, context);
			expect((await host.get(Metric, {}, context)).reading.value).toBe(1);
			const target = removed === "directory" ? dir : join(dir, removed === "manifest" ? "package.json" : "worker.ts");
			rmSync(target, { recursive: true });
			const built = await plugins.build(["meter"], context);
			expect(built.facets).toEqual([]);
			expect((await plugins.reload(host, built, context)).plugins.removed).toEqual(["meter"]);
			const added = join(root, "fresh");
			mkdirSync(added);
			writeFileSync(join(added, "package.json"), JSON.stringify({ name: "fresh", type: "module" }));
			writeFileSync(join(added, "worker.ts"), source(9));
			const next = await plugins.build(["fresh"], context);
			expect(Object.keys(next.plugins)).toContain("fresh");
			expect((await plugins.reload(host, next, context)).plugins.added).toEqual(["fresh"]);
			expect((await host.get(Metric, {}, context)).reading.value).toBe(9);
		} finally {
			await host.close(context);
			plugins.close();
			await rm(root, { recursive: true, force: true });
		}
	},
);

it("updates a loaded plugin, keeps its last working code after a broken edit, and applies a later repair", async () => {
	const root = await mkdtemp(join(tmpdir(), "axi-plugins-"));
	const dir = await fixture(root, { "worker.ts": source(4) });
	const plugins = createPlugins(
		{ roots: [root], kinds: { worker: { platform: "node", hostPackages: Object.keys(packages) } }, onError: () => {} },
		context,
	);
	const host = api.createHost({ onError: () => {} });
	try {
		expect((await plugins.load(host, { kind: "worker", core: [], modules: packages }, context)).failed).toEqual([]);
		const ref = await host.get(Metric, {}, context);
		await writeFile(join(dir, "worker.ts"), source(8));
		await vi.waitFor(() => expect(plugins.state.value.dirty).toEqual(["meter"]));
		const changed = await plugins.rollout(
			[plugins.step("main", host)],
			await plugins.build(["meter"], context),
			context,
		);
		expect(changed.stopped).toBeUndefined();
		await vi.waitFor(() => expect(ref.reading.value).toBe(8));
		await writeFile(join(dir, "worker.ts"), "export default {");
		expect(
			(await plugins.reload(host, await plugins.build(["meter"], context), context)).failed.map(({ plugin }) => plugin),
		).toEqual(["meter"]);
		expect(ref.reading.value).toBe(8);
		await writeFile(join(dir, "worker.ts"), source(12));
		expect(
			(await plugins.reload(host, structuredClone(await plugins.build(["meter"], context)), context)).failed,
		).toEqual([]);
		await vi.waitFor(() => expect(ref.reading.value).toBe(12));
	} finally {
		await host.close(context);
		plugins.close();
		await rm(root, { recursive: true, force: true });
	}
});

it("maps evaluation errors back to the plugin source and refuses file access outside the plugin", async () => {
	const root = await mkdtemp(join(tmpdir(), "axi-plugins-"));
	await fixture(root, {
		"worker.ts": `import {pluginFile} from "@axi/objects/plugins";
export default {setup(){},escape(){return pluginFile("../elsewhere");},fail(){throw new Error("plugin failed");}};`,
	});
	try {
		const {
			plugins: [plugin],
		} = await discoverPlugins([root], { kinds: ["worker"] }, context);
		const built = await buildFacet(plugin, "worker", { hostPackages: [], platform: "node" }, context);
		if (built.kind === "failed") throw new Error(built.errors.join("\n"));
		const facet = evaluateFacet(built, { plugin, hostPackages: {} }) as unknown as { escape(): string; fail(): void };
		expect(() => facet.escape()).toThrow("outside the directory");
		let error: unknown;
		try {
			facet.fail();
		} catch (failure) {
			error = failure;
		}
		expect(mapStack(error)).toContain("meter/worker.ts:2:");
		expect(await readFile(join(plugin.dir, "worker.ts"), "utf8")).toContain("plugin failed");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("keeps edits newer than an applied build even after an older rollout finishes", async () => {
	const root = await mkdtemp(join(tmpdir(), "axi-plugins-"));
	const dir = await fixture(root, { "worker.ts": source(1) });
	const watcher = new PluginWatcher(
		{ roots: [root], base: [], kinds: ["worker"], failed: () => {} },
		new Batch(() => {}, undefined),
	);
	try {
		watcher.know(await discoverPlugins([root], { kinds: ["worker"] }, context), watcher.discoverySnapshot());
		const file = join(dir, "worker.ts");
		watcher.mark(file);
		const older = watcher.snapshot(["meter"]);
		watcher.mark(file);
		const newer = watcher.snapshot(["meter"]);
		watcher.applied(["meter"], newer);
		expect(watcher.value).toMatchObject({ dirty: [] });
		watcher.mark(file);
		watcher.applied(["meter"], older);
		expect(watcher.value).toMatchObject({ dirty: ["meter"] });
	} finally {
		watcher.close();
		await rm(root, { recursive: true, force: true });
	}
});

it("retains the loaded host kind when the caller later changes its options object", async () => {
	const root = await mkdtemp(join(tmpdir(), "axi-plugins-"));
	await fixture(root, { "worker.ts": source(1), "server.ts": source(99) });
	const plugins = createPlugins(
		{
			roots: [root],
			kinds: {
				worker: { platform: "node", hostPackages: Object.keys(packages) },
				server: { platform: "node", hostPackages: Object.keys(packages) },
			},
			onError: () => {},
		},
		context,
	);
	const host = api.createHost({ onError: () => {} });
	try {
		const options = { kind: "worker", core: [], modules: packages };
		await plugins.load(host, options, context);
		options.kind = "server";
		const report = await plugins.reload(host, await plugins.build(["meter"], context), context);
		expect(report.plugins.changed).toEqual([]);
		expect((await host.get(Metric, {}, context)).reading.value).toBe(1);
	} finally {
		await host.close(context);
		plugins.close();
		await rm(root, { recursive: true, force: true });
	}
});
