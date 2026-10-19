import { utf8ByteLength } from "@axi/chord/output";
export { utf8ByteLength };
export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024;
export interface TruncationOptions {
	maxLines?: number;
	maxBytes?: number;
}
export interface TruncationResult {
	content: string;
	truncated: boolean;
	truncatedBy: "lines" | "bytes" | null;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	lastLinePartial: boolean;
	firstLineExceedsLimit: boolean;
	maxLines: number;
	maxBytes: number;
}
function linesOf(text: string): string[] {
	if (!text.length) return [];
	const lines = text.split("\n");
	if (text.endsWith("\n")) lines.pop();
	return lines;
}
export function formatSize(bytes: number): string {
	return bytes < 1024
		? `${bytes}B`
		: bytes < 1048576
			? `${(bytes / 1024).toFixed(1)}KB`
			: `${(bytes / 1048576).toFixed(1)}MB`;
}
export function truncateHead(text: string, options: TruncationOptions = {}): TruncationResult {
	return truncateHeadOf(text, { lines: linesOf(text).length, bytes: utf8ByteLength(text) }, options);
}
export function truncateHeadOf(
	prefix: string,
	totals: { readonly lines: number; readonly bytes: number },
	options: TruncationOptions = {},
): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const result: TruncationResult = {
		content: prefix,
		truncated: false,
		truncatedBy: null,
		totalLines: totals.lines,
		totalBytes: totals.bytes,
		outputLines: totals.lines,
		outputBytes: totals.bytes,
		lastLinePartial: false,
		firstLineExceedsLimit: false,
		maxLines,
		maxBytes,
	};
	if (totals.lines <= maxLines && totals.bytes <= maxBytes) return result;
	const lines = linesOf(prefix);
	const firstLineExceedsLimit = utf8ByteLength(lines[0]) > maxBytes;
	const kept: string[] = [];
	let used = 0;
	for (let index = 0; !firstLineExceedsLimit && index < lines.length && index < maxLines; index++) {
		const cost = utf8ByteLength(lines[index]) + (index ? 1 : 0);
		if (used + cost > maxBytes) {
			result.truncatedBy = "bytes";
			break;
		}
		kept.push(lines[index]);
		used += cost;
	}
	return {
		...result,
		content: kept.join("\n"),
		truncated: true,
		truncatedBy: firstLineExceedsLimit
			? "bytes"
			: (result.truncatedBy ?? (kept.length < totals.lines ? "lines" : "bytes")),
		outputLines: kept.length,
		outputBytes: used,
		firstLineExceedsLimit,
	};
}
