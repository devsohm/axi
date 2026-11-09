import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import { createHost, defineFacet, defineRegistry } from "../src/index.ts";
import * as api from "../src/index.ts";
import { buildFacet, discoverPlugins, evaluateFacet } from "../src/node/plugins/index.ts";

test("browser plugins get stable, isolated CSS classes with global selectors and external assets intact", async () => {
	const root = await mkdtemp(join(tmpdir(), "axi-plugin-css-"));
	const Styles = defineRegistry<Readonly<Record<string, string>>, readonly Readonly<Record<string, string>>[]>(
		"test.styles",
		{ version: 1 },
	);
	const modules = { "@example/web": { ...api, Styles } };
	const host = createHost({
		onError(error) {
			throw error;
		},
	});
	const source = `import { defineFacet, Styles } from "@example/web";
import classes from "./card.module.css";
export default defineFacet((_host, self) => self.contribute(Styles, classes));`;
	try {
		for (const name of ["alpha", "beta"]) {
			await mkdir(join(root, name));
			await writeFile(join(root, name, "package.json"), JSON.stringify({ name, type: "module" }));
			await writeFile(join(root, name, "web.ts"), source);
			await writeFile(
				join(root, name, "card.module.css"),
				`.row { color: rebeccapurple; background: url("https://assets.example/tile.png"); }
.selected { composes: row; font-weight: bold; }
:global(.shared) { display: block; }`,
			);
		}
		const discovered = await discoverPlugins([root], { kinds: ["web"] }, context);
		expect(discovered.problems).toEqual([]);
		const built = await Promise.all(
			discovered.plugins.map(async (plugin) => {
				const result = await buildFacet(
					plugin,
					"web",
					{ platform: "browser", hostPackages: Object.keys(modules) },
					context,
				);
				if (result.kind === "failed") throw new Error(result.errors.join("\n"));
				return { plugin, result };
			}),
		);
		await host.load(
			[
				{
					name: "styles",
					facet: defineFacet((facet) =>
						facet.serve(Styles, { compose: (entries) => entries.map(({ value }) => value) }),
					),
				},
				...built.map(({ plugin, result }) => ({
					name: plugin.name,
					facet: evaluateFacet(result, { plugin, hostPackages: modules }),
				})),
			],
			context,
		);
		const registry = await host.registry(Styles, context);
		expect(registry.value).toHaveLength(2);
		const [first, second] = registry.value;
		expect(first!.row).not.toBe(second!.row);
		for (const [index, { plugin, result }] of built.entries()) {
			const names = registry.value[index]!;
			expect(names.selected!.split(" ")).toContain(names.row);
			expect(result.css?.text).toContain(`.${names.row}`);
			expect(result.css?.text).toContain(".shared");
			expect(result.css?.text).toContain("https://assets.example/tile.png");
			await writeFile(join(plugin.dir, "card.module.css"), ".row { color: orange; } .selected { composes: row; }");
			const updated = await buildFacet(
				plugin,
				"web",
				{ platform: "browser", hostPackages: Object.keys(modules) },
				context,
			);
			if (updated.kind === "failed") throw new Error(updated.errors.join("\n"));
			expect(updated.css?.text).toContain(`.${names.row}`);
			expect(updated.css?.text).toContain("orange");
		}
		const node = await buildFacet(
			discovered.plugins[0]!,
			"web",
			{ platform: "node", hostPackages: Object.keys(modules) },
			context,
		);
		expect(node).toMatchObject({
			kind: "failed",
			errors: [expect.stringContaining("stylesheets and assets are for browser builds")],
		});
	} finally {
		await host.close(context);
		await rm(root, { recursive: true, force: true });
	}
});
