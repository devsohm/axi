import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
