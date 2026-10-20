import { expect, test } from "vitest";
import {
	applyEditsToNormalizedContent,
	applyReplacementsPreservingUnchangedLines,
	detectLineEnding,
	fuzzyFindText,
	generateDiffString,
	generateUnifiedPatch,
	normalizeToLF,
	restoreLineEndings,
	stripBom,
} from "../src/tools/edit-diff.ts";

test("fuzzy replacement changes only matched lines while keeping neighboring typography", () => {
	const source = "Keep ‘original’  \nconst title = “Old”;  \nKeep — this\n";
	expect(
		applyEditsToNormalizedContent(
			source,
			[{ oldText: 'const title = "Old";', newText: 'const title = "New";' }],
			"a.ts",
		),
	).toEqual({
		baseContent: source,
		newContent: 'Keep ‘original’  \nconst title = "New";\nKeep — this\n',
	});
	expect(fuzzyFindText("unrelated", "missing")).toEqual({
		found: false,
		index: -1,
		matchLength: 0,
		usedFuzzyMatch: false,
		contentForReplacement: "unrelated",
	});
	expect(fuzzyFindText("alpha beta", "beta")).toEqual({
		found: true,
		index: 6,
		matchLength: 4,
		usedFuzzyMatch: false,
		contentForReplacement: "alpha beta",
	});
});

test("edits match the original file, preserve input ordering and support multiple matches on one line", () => {
	expect(
		applyEditsToNormalizedContent(
			"left middle right\n",
			[
				{ oldText: "right", newText: "LEFT" },
				{ oldText: "left", newText: "RIGHT" },
			],
			"a.txt",
		).newContent,
	).toBe("RIGHT middle LEFT\n");
	expect(
		applyEditsToNormalizedContent(
			"‘a’ and ‘b’\n",
			[
				{ oldText: "'b'", newText: "B" },
				{ oldText: "'a'", newText: "A" },
			],
			"a.txt",
		).newContent,
	).toBe("A and B\n");
});

test("invalid edits report empty, absent, ambiguous, overlapping and unchanged replacements", () => {
	for (const [edits, message] of [
		[[{ oldText: "", newText: "x" }], "oldText must not be empty"],
		[[{ oldText: "no", newText: "x" }], "Could not find the exact text"],
		[[{ oldText: "a", newText: "x" }], "Found 2 occurrences"],
		[
			[
				{ oldText: "ab", newText: "x" },
				{ oldText: "bc", newText: "y" },
			],
			"overlap",
		],
		[[{ oldText: "abc", newText: "abc" }], "No changes made"],
		[
			[
				{ oldText: "abc", newText: "x" },
				{ oldText: "", newText: "y" },
			],
			"edits[1].oldText must not be empty",
		],
		[
			[
				{ oldText: "abc", newText: "x" },
				{ oldText: "absent", newText: "y" },
			],
			"Could not find edits[1]",
		],
		[
			[
				{ oldText: "bc", newText: "x" },
				{ oldText: "a", newText: "y" },
			],
			"occurrences of edits[1]",
		],
		[
			[
				{ oldText: "abc", newText: "abc" },
				{ oldText: "a2", newText: "a2" },
			],
			"replacements produced identical",
		],
	] satisfies [{ oldText: string; newText: string }[], string][]) {
		expect(() => applyEditsToNormalizedContent("abc a2", edits, "a.txt")).toThrow(message);
	}
});

test("preserved-line replacements reject mismatched bases and out-of-file ranges", () => {
	expect(() => applyReplacementsPreservingUnchangedLines("a\nb", "ab", [])).toThrow("different line count");
	for (const replacement of [
		{ matchIndex: -1, matchLength: 1, newText: "x" },
		{ matchIndex: 0, matchLength: 9, newText: "x" },
	]) {
		expect(() => applyReplacementsPreservingUnchangedLines("ab", "ab", [replacement])).toThrow(
			"outside the base content",
		);
	}
	expect(applyReplacementsPreservingUnchangedLines("", "", [])).toBe("");
});

test("line ending and BOM handling preserve an edited file's envelope", () => {
	const { bom, text } = stripBom("\ufeffa\r\nb\r\n");
	const edited = applyEditsToNormalizedContent(normalizeToLF(text), [{ oldText: "b", newText: "B\r\nC" }], "a.txt");
	expect(bom + restoreLineEndings(edited.newContent, detectLineEnding(text))).toBe("\ufeffa\r\nB\r\nC\r\n");
	expect(stripBom("plain")).toEqual({ bom: "", text: "plain" });
	expect(detectLineEnding("one\ntwo\r\n")).toBe("\n");
	expect(detectLineEnding("one")).toBe("\n");
	expect(restoreLineEndings(normalizeToLF("a\rb\r\nc"), "\n")).toBe("a\nb\nc");
});

test("diffs report additions, removals and separated hunks with literal line numbers", () => {
	expect(generateDiffString("a\nb\nc\n", "a\nB\nc\n", 1)).toEqual({
		diff: " 1 a\n-2 b\n+2 B\n 3 c",
		firstChangedLine: 2,
	});
	expect(generateDiffString("a\n", "a\nb\n", 1)).toEqual({ diff: " 1 a\n+2 b", firstChangedLine: 2 });
	expect(generateDiffString("a\nb\n", "a\n", 1)).toEqual({ diff: " 1 a\n-2 b", firstChangedLine: 2 });
	expect(generateDiffString("same", "same")).toEqual({ diff: "", firstChangedLine: undefined });
	expect(generateUnifiedPatch("a.txt", "old\n", "new\n")).toBe("--- a.txt\n+++ a.txt\n@@ -1,1 +1,1 @@\n-old\n+new\n");
	expect(generateDiffString("a\nb\nc\nd\ne\nf\ng\n", "A\nb\nc\nd\ne\nf\nG\n", 1)).toEqual({
		diff: "-1 a\n+1 A\n 2 b\n   ...\n 6 f\n-7 g\n+7 G",
		firstChangedLine: 1,
	});
});
