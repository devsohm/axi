import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { CombinedAutocompleteProvider } from "../src/autocomplete.ts";

const options = () => ({ signal: new AbortController().signal });

test("command completion includes argument hints, legacy items and skill names without duplicating matches", async () => {
	const provider = new CombinedAutocompleteProvider(
		[
			{
				name: "mode",
				argumentHint: "<name>",
				description: "Choose mode",
				getArgumentCompletions: (prefix) => (prefix === "go" ? [{ value: "good", label: "Good" }] : []),
			},
			{ name: "skill:review", argumentHint: "[path]" },
			{ value: "help", label: "Help", description: "List commands" },
		],
		tmpdir(),
	);
	expect(await provider.getSuggestions(["/mo"], 0, 3, options())).toEqual({
		prefix: "/mo",
		items: [{ value: "mode", label: "mode", description: "<name> — Choose mode" }],
	});
	expect(await provider.getSuggestions(["/help"], 0, 5, options())).toEqual({
		prefix: "/help",
		items: [{ value: "help", label: "help", description: "List commands" }],
	});
	for (const input of ["/rev", "/skill:rev"])
		expect((await provider.getSuggestions([input], 0, input.length, options()))?.items).toEqual([
			{ value: "skill:review", label: "skill:review", description: "[path]" },
		]);
	expect(await provider.getSuggestions(["/mode go"], 0, 8, options())).toEqual({
		prefix: "go",
		items: [{ value: "good", label: "Good" }],
	});
	for (const input of ["/mode none", "/unknown ", "/help ", "/absent"])
		expect(await provider.getSuggestions([input], 0, input.length, options())).toBeNull();
	expect(provider.applyCompletion(["/mo"], 0, 3, { value: "mode", label: "mode" }, "/mo")).toEqual({
		lines: ["/mode "],
		cursorLine: 0,
		cursorCol: 6,
	});
	expect(provider.shouldTriggerFileCompletion(["/mode"], 0, 5)).toBe(false);
	expect(provider.shouldTriggerFileCompletion(["/mode file"], 0, 10)).toBe(true);
});

test("filesystem completion quotes paths, follows directory links and handles unavailable directories", async () => {
	const root = await mkdtemp(join(tmpdir(), "axi-completion-boundaries-"));
	try {
		await mkdir(join(root, "folder name"));
		await writeFile(join(root, "folder name", "inside.ts"), "");
		await writeFile(join(root, "document file.ts"), "");
		await symlink(join(root, "folder name"), join(root, "linked"), "junction");
		const provider = new CombinedAutocompleteProvider([], root);
		const found = await provider.getSuggestions(["./"], 0, 2, options());
		expect(found).toEqual({
			prefix: "./",
			items: [
				{ value: '"./folder name/"', label: "folder name/" },
				{ value: "./linked/", label: "linked/" },
				{ value: '"./document file.ts"', label: "document file.ts" },
			],
		});
		const input = '"./folder name/in';
		expect(await provider.getSuggestions([input], 0, input.length, options())).toEqual({
			prefix: input,
			items: [{ value: '"./folder name/inside.ts"', label: "inside.ts" }],
		});
		for (const input of ["word", "", "./missing/", "@document"])
			expect(await provider.getSuggestions([input], 0, input.length, options())).toBeNull();
		const missing = new CombinedAutocompleteProvider([], join(root, "absent"));
		expect(await missing.getSuggestions(["./"], 0, 2, options())).toBeNull();
		expect(
			provider.applyCompletion(['@"do"'], 0, 4, { value: '@"document file.ts"', label: "document file.ts" }, '@"do'),
		).toEqual({ lines: ['@"document file.ts" '], cursorLine: 0, cursorCol: 20 });
		expect(
			provider.applyCompletion(['"./fo"'], 0, 5, { value: '"./folder name/"', label: "folder name/" }, '"./fo'),
		).toEqual({ lines: ['"./folder name/"'], cursorLine: 0, cursorCol: 15 });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
