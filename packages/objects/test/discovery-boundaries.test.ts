import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { BACKGROUND_CONTEXT as context, withAbortSignal } from "../src/context/index.ts";
import { discoverPlugins } from "../src/node/plugins/index.ts";

test("plugin discovery reports malformed manifests and ambiguous facets without evaluating code", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "axi-discovery-errors-")));
	try {
		for (const [name, manifest, files, message] of [
			["missing", undefined, ["worker.ts"], "no package.json"],
			["broken", "{", ["worker.ts"], "package.json"],
			["null", "null", ["worker.ts"], "valid plugin name"],
			["name", JSON.stringify({ name: "bad name" }), ["worker.ts"], "valid plugin name"],
			[
				"externals",
				JSON.stringify({ name: "externals", objects: { external: [1] } }),
				["worker.ts"],
				"objects.external",
			],
			["duplicate", JSON.stringify({ name: "duplicate" }), ["worker.ts", "worker.js"], "two worker facets"],
		] satisfies [string, string | undefined, string[], string][]) {
			const parent = join(root, name),
				directory = join(parent, "plugin");
			await mkdir(directory, { recursive: true });
			if (manifest !== undefined) await writeFile(join(directory, "package.json"), manifest);
			for (const file of files)
				await writeFile(join(directory, file), 'throw new Error("Must not evaluate during discovery");');
			const found = await discoverPlugins([parent], { kinds: ["worker"] }, context);
			expect(found.plugins).toEqual([]);
			expect(found.problems).toEqual([
				expect.objectContaining({ path: directory, error: expect.stringContaining(message) }),
			]);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("declared plugin paths reject escapes, overlapping roots and missing packages", async () => {
	const root = await mkdtemp(join(tmpdir(), "axi-discovery-paths-"));
	try {
		const directory = join(root, "package"),
			outside = join(root, "outside");
		await mkdir(join(directory, "nested", "inner"), { recursive: true });
		await mkdir(outside);
		await writeFile(join(directory, "plain.txt"), "not a plugin directory");
		await symlink(outside, join(directory, "linked"), "junction");
		for (const [plugins, message] of [
			[{}, "not a list"],
			[[], "no plugin folder"],
			[["../outside"], "outside"],
			[["nested", "nested/inner"], "inside the listed"],
			[["absent"], "not a directory"],
			[["plain.txt"], "not a directory"],
			[["linked"], "links out"],
			[["nested"], "no package.json"],
		] satisfies [unknown, string][]) {
			await writeFile(join(directory, "package.json"), JSON.stringify({ objects: { plugins } }));
			const found = await discoverPlugins([root], { kinds: ["worker"] }, context);
			expect(found.plugins).toEqual([]);
			expect(found.problems.some((problem) => problem.error.includes(message))).toBe(true);
		}
		expect(await discoverPlugins([join(root, "missing")], { kinds: ["worker"] }, context)).toEqual({
			plugins: [],
			problems: [],
		});
		await expect(
			discoverPlugins([root], { kinds: ["worker"] }, withAbortSignal(AbortSignal.abort(), context)),
		).rejects.toThrow();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
