import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { expect, test } from "vitest";
import { CombinedAutocompleteProvider } from "../src/autocomplete.ts";

test("completion finds commands and arguments, quotes filesystem paths and preserves following text", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "axi-completion-"));
	try {
		await mkdir(join(cwd, "folder"));
		await writeFile(join(cwd, "notes file.ts"), "");
		const provider = new CombinedAutocompleteProvider(
			[
				{
					name: "mode",
					getArgumentCompletions: async (prefix) => (prefix === "fa" ? [{ value: "fast", label: "Fast" }] : null),
				},
			],
			cwd,
		);
		const options = { signal: new AbortController().signal };
		expect(await provider.getSuggestions(["/mo"], 0, 3, options)).toEqual({
			prefix: "/mo",
			items: [{ value: "mode", label: "mode" }],
		});
		expect(await provider.getSuggestions(["/mode fa"], 0, 8, options)).toEqual({
			prefix: "fa",
			items: [{ value: "fast", label: "Fast" }],
		});
		const paths = await provider.getSuggestions(["./no"], 0, 4, options);
		expect(paths).toEqual({ prefix: "./no", items: [{ value: '"./notes file.ts"', label: "notes file.ts" }] });
		expect(provider.applyCompletion(["use ./no later"], 0, 8, paths!.items[0]!, paths!.prefix)).toEqual({
			lines: ['use "./notes file.ts" later'],
			cursorLine: 0,
			cursorCol: 21,
		});
		expect((await provider.getSuggestions(["./fo"], 0, 4, options))?.items.map((item) => item.value)).toEqual([
			"./folder/",
		]);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("home-directory completion preserves tilde paths and permits completing a quoted child", async () => {
	const directory = await mkdtemp(join(homedir(), "axi-home-completion-"));
	try {
		await mkdir(join(directory, "nested"));
		await writeFile(join(directory, "notes.md"), "");
		const provider = new CombinedAutocompleteProvider([], tmpdir()),
			options = { signal: new AbortController().signal };
		const prefix = `~/${basename(directory)}/`;
		for (const path of [prefix, `${prefix}no`, `"${prefix}no`]) {
			const suggestions = await provider.getSuggestions([path], 0, path.length, options);
			expect(suggestions?.items).toContainEqual({
				value: path.startsWith('"') ? `"${prefix}notes.md"` : `${prefix}notes.md`,
				label: "notes.md",
			});
		}
		const home = await provider.getSuggestions(["~"], 0, 1, { ...options, force: true });
		expect(home?.items).toContainEqual({ value: `~/${basename(directory)}/`, label: `${basename(directory)}/` });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
