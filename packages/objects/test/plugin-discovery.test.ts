import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import { discoverPlugins } from "../src/node/plugins/discover.ts";

test("same-root file collisions name the local directory before reporting cross-root duplicates", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "axi-plugin-collision-")));
	try {
		const roots = [join(root, "first"), join(root, "second")];
		for (const path of roots) {
			await mkdir(join(path, "same"), { recursive: true });
			await writeFile(join(path, "same", "package.json"), JSON.stringify({ name: "same" }));
		}
		await writeFile(join(roots[1], "same.worker.ts"), "export default {};");
		const { plugins, problems } = await discoverPlugins(roots, { kinds: ["worker"] }, context);
		expect(plugins.map(({ dir }) => dir)).toEqual([join(roots[0], "same")]);
		expect(problems).toEqual([
			{
				path: join(roots[1], "same.worker.ts"),
				root: roots[1],
				required: false,
				error: `plugin "same" is in ${join(roots[1], "same")} already`,
			},
			{
				path: join(roots[1], "same"),
				root: roots[1],
				required: false,
				error: `plugin "same" is in ${join(roots[0], "same")} already`,
			},
		]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("plugin roots discover declared package folders and single files without executing them", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "axi-discovery-")));
	try {
		const packageRoot = join(root, "bundle");
		for (const name of ["keep", "drop"]) {
			const dir = join(packageRoot, "plugins", name);
			await mkdir(dir, { recursive: true });
			await writeFile(join(dir, "package.json"), JSON.stringify({ name }));
			await writeFile(join(dir, "worker.ts"), 'throw new Error("Do not execute during discovery")');
		}
		await writeFile(
			join(packageRoot, "package.json"),
			JSON.stringify({ objects: { plugins: ["plugins/*", "!plugins/drop"] } }),
		);
		await writeFile(join(root, "hello.worker.ts"), 'throw new Error("Do not execute during discovery")');
		const result = await discoverPlugins([{ path: root, required: true }], { kinds: ["worker"] }, context);
		expect(result.problems).toEqual([]);
		expect(
			result.plugins.map(({ name, root: found, required, layout }) => ({ name, root: found, required, layout })),
		).toEqual([
			{ name: "hello", root, required: true, layout: "file" },
			{ name: "keep", root, required: true, layout: "directory" },
		]);
		const missing = join(root, "absent");
		expect(
			(await discoverPlugins([{ path: missing, required: true }], { kinds: ["worker"] }, context)).problems,
		).toEqual([{ path: missing, root: missing, required: true, error: "the required root does not exist" }]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
