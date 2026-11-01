import { createTwoFilesPatch, diffLines, FILE_HEADERS_ONLY } from "diff";

export function detectLineEnding(content: string): "\r\n" | "\n" {
	const first = content.indexOf("\n");
	return first > 0 && content[first - 1] === "\r" ? "\r\n" : "\n";
}
export const normalizeToLF = (text: string): string => text.replace(/\r\n?/g, "\n");
export const restoreLineEndings = (text: string, ending: "\r\n" | "\n"): string =>
	ending === "\n" ? text : text.replace(/\n/g, ending);
export function stripBom(text: string): { bom: string; text: string } {
	return text.startsWith("\ufeff") ? { bom: "\ufeff", text: text.slice(1) } : { bom: "", text };
}
export function normalizeForFuzzyMatch(text: string): string {
	return text
		.normalize("NFKC")
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.replace(/[\u2018-\u201b]/g, "'")
		.replace(/[\u201c-\u201f]/g, '"')
		.replace(/[\u2010-\u2015\u2212]/g, "-")
		.replace(/[\u00a0\u2002-\u200a\u202f\u205f\u3000]/g, " ");
}
export interface Edit {
	oldText: string;
	newText: string;
}
export interface FuzzyMatchResult {
	found: boolean;
	index: number;
	matchLength: number;
	usedFuzzyMatch: boolean;
	contentForReplacement: string;
}
export interface AppliedEditsResult {
	baseContent: string;
	newContent: string;
}
type Replacement = { matchIndex: number; matchLength: number; newText: string };

export function fuzzyFindText(content: string, oldText: string): FuzzyMatchResult {
	let index = content.indexOf(oldText);
	if (index >= 0)
		return { found: true, index, matchLength: oldText.length, usedFuzzyMatch: false, contentForReplacement: content };
	const normalized = normalizeForFuzzyMatch(content);
	const target = normalizeForFuzzyMatch(oldText);
	index = normalized.indexOf(target);
	return index < 0
		? { found: false, index: -1, matchLength: 0, usedFuzzyMatch: false, contentForReplacement: content }
		: { found: true, index, matchLength: target.length, usedFuzzyMatch: true, contentForReplacement: normalized };
}

function replaceRanges(content: string, replacements: Replacement[], offset = 0): string {
	let result = content;
	for (const replacement of [...replacements].reverse()) {
		const start = replacement.matchIndex - offset;
		result = result.substring(0, start) + replacement.newText + result.substring(start + replacement.matchLength);
	}
	return result;
}

export function applyReplacementsPreservingUnchangedLines(
	originalContent: string,
	baseContent: string,
	replacements: Replacement[],
): string {
	const original = originalContent.match(/[^\n]*\n|[^\n]+/g) ?? [];
	let position = 0;
	const lines = (baseContent.match(/[^\n]*\n|[^\n]+/g) ?? []).map((line) => {
		const start = position;
		position += line.length;
		return { start, end: position };
	});
	if (original.length !== lines.length)
		throw new Error("Cannot preserve unchanged lines because the base content has a different line count.");
	const groups: { start: number; end: number; edits: Replacement[] }[] = [];
	for (const edit of [...replacements].sort((a, b) => a.matchIndex - b.matchIndex)) {
		const start = lines.findIndex((line) => line.start <= edit.matchIndex && line.end > edit.matchIndex);
		if (start < 0) throw new Error("Replacement range is outside the base content.");
		let end = start;
		while (end < lines.length && lines[end]!.end < edit.matchIndex + edit.matchLength) end++;
		if (end === lines.length) throw new Error("Replacement range is outside the base content.");
		const previous = groups.at(-1);
		if (previous && start < previous.end) {
			previous.end = Math.max(previous.end, end + 1);
			previous.edits.push(edit);
		} else groups.push({ start, end: end + 1, edits: [edit] });
	}
	let cursor = 0;
	const chunks: string[] = [];
	for (const group of groups) {
		chunks.push(original.slice(cursor, group.start).join(""));
		const start = lines[group.start]!.start;
		chunks.push(replaceRanges(baseContent.slice(start, lines[group.end - 1]!.end), group.edits, start));
		cursor = group.end;
	}
	return chunks.join("") + original.slice(cursor).join("");
}

export function applyEditsToNormalizedContent(content: string, edits: Edit[], path: string): AppliedEditsResult {
	const normalized = edits.map(({ oldText, newText }) => ({
		oldText: normalizeToLF(oldText),
		newText: normalizeToLF(newText),
	}));
	for (const [index, edit] of normalized.entries()) {
		if (edit.oldText.length === 0)
			throw new Error(
				normalized.length === 1
					? `oldText must not be empty in ${path}.`
					: `edits[${index}].oldText must not be empty in ${path}.`,
			);
	}
	const fuzzy = normalized.some((edit) => fuzzyFindText(content, edit.oldText).usedFuzzyMatch);
	const base = fuzzy ? normalizeForFuzzyMatch(content) : content;
	const matches = normalized
		.map((edit, index) => {
			const match = fuzzyFindText(base, edit.oldText);
			if (!match.found)
				throw new Error(
					normalized.length === 1
						? `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`
						: `Could not find edits[${index}] in ${path}. The oldText must match exactly including all whitespace and newlines.`,
				);
			const count = normalizeForFuzzyMatch(base).split(normalizeForFuzzyMatch(edit.oldText)).length - 1;
			if (count > 1)
				throw new Error(
					normalized.length === 1
						? `Found ${count} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`
						: `Found ${count} occurrences of edits[${index}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`,
				);
			return { index, matchIndex: match.index, matchLength: match.matchLength, newText: edit.newText };
		})
		.sort((a, b) => a.matchIndex - b.matchIndex);
	for (let index = 1; index < matches.length; index++) {
		const left = matches[index - 1]!;
		const right = matches[index]!;
		if (left.matchIndex + left.matchLength > right.matchIndex)
			throw new Error(
				`edits[${left.index}] and edits[${right.index}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
			);
	}
	const newContent = fuzzy
		? applyReplacementsPreservingUnchangedLines(content, base, matches)
		: replaceRanges(base, matches);
	if (newContent === content)
		throw new Error(
			normalized.length === 1
				? `No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`
				: `No changes made to ${path}. The replacements produced identical content.`,
		);
	return { baseContent: content, newContent };
}

export function generateUnifiedPatch(path: string, oldContent: string, newContent: string, contextLines = 4): string {
	return createTwoFilesPatch(path, path, oldContent, newContent, undefined, undefined, {
		context: contextLines,
		headerOptions: FILE_HEADERS_ONLY,
	});
}

export function generateDiffString(
	oldContent: string,
	newContent: string,
	contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
	const parts = diffLines(oldContent, newContent);
	const width = String(Math.max(oldContent.split("\n").length, newContent.split("\n").length)).length;
	const result: string[] = [];
	let oldLine = 1;
	let newLine = 1;
	let firstChangedLine: number | undefined;
	const ellipsis = () => result.push(` ${" ".repeat(width)} ...`);
	const context = (lines: readonly string[]) => {
		for (const line of lines) {
			result.push(` ${String(oldLine++).padStart(width, " ")} ${line}`);
			newLine++;
		}
	};
	for (const [index, part] of parts.entries()) {
		const lines = part.value.split("\n");
		if (lines.at(-1) === "") lines.pop();
		if (part.added || part.removed) {
			firstChangedLine ??= newLine;
			for (const line of lines)
				result.push(
					`${part.added ? "+" : "-"}${String(part.added ? newLine++ : oldLine++).padStart(width, " ")} ${line}`,
				);
			continue;
		}
		const before = !!(parts[index - 1]?.added || parts[index - 1]?.removed);
		const after = !!(parts[index + 1]?.added || parts[index + 1]?.removed);
		if (!before && !after) {
			oldLine += lines.length;
			newLine += lines.length;
			continue;
		}
		if (before && after && lines.length <= contextLines * 2) {
			context(lines);
			continue;
		}
		const leading = before ? lines.slice(0, contextLines) : [];
		const skipped = before
			? lines.length - leading.length - (after ? lines.slice(lines.length - contextLines).length : 0)
			: Math.max(0, lines.length - contextLines);
		const trailing = after ? lines.slice(before ? lines.length - contextLines : skipped) : [];
		context(leading);
		if ((before && after) || skipped > 0) {
			ellipsis();
			oldLine += skipped;
			newLine += skipped;
		}
		context(trailing);
	}
	return { diff: result.join("\n"), firstChangedLine };
}
