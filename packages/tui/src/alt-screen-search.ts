import { Input } from "./components/input.ts";
import { getKeybindings } from "./keybindings.ts";
import type { Component, Focusable } from "./tui.ts";
import { getGraphemeSegmenter, stripTerminalSequences, truncateToWidth, visibleWidth } from "./utils.ts";
export interface AltScreenSearchSegment {
	row: number;
	startCol: number;
	endCol: number;
}
export interface AltScreenSearchMatch {
	segments: AltScreenSearchSegment[];
}
export interface AltScreenSearchResult {
	matches: AltScreenSearchMatch[];
	changed: boolean;
}
type Span = AltScreenSearchSegment & { start: number; end: number; linear: boolean };
type Corpus = { text: string; spans: Span[] };
const segmenter = getGraphemeSegmenter();
function corpus(lines: readonly string[]): Corpus {
	const chunks: string[] = [],
		spans: Span[] = [];
	let length = 0,
		separate = false;
	function append(text: string, row: number, startCol: number, endCol: number, linear: boolean): void {
		if (separate) {
			chunks.push(" ");
			length++;
			separate = false;
		}
		chunks.push(text);
		spans.push({ start: length, end: length + text.length, row, startCol, endCol, linear });
		length += text.length;
	}
	for (let row = 0; row < lines.length; row++) {
		const line = stripTerminalSequences(lines[row] ?? "");
		if (/^[\x20-\x7e]*$/.test(line)) {
			for (let index = 0; index < line.length; ) {
				if (line[index] === " ") {
					if (length) separate = true;
					index++;
					continue;
				}
				let end = index + 1;
				while (end < line.length && line[end] !== " ") end++;
				append(line.slice(index, end), row, index, end, true);
				index = end;
			}
		} else {
			let column = 0;
			for (const { segment } of segmenter.segment(line)) {
				const width = visibleWidth(segment);
				if (/^\s+$/u.test(segment)) {
					if (length) separate = true;
				} else append(segment, row, column, column + width, false);
				column += width;
			}
		}
		if (length) separate = true;
	}
	return { text: chunks.join(""), spans };
}
const normalize = (query: string) => query.replace(/\s+/gu, " ").trim();
function matches(c: Corpus, query: string): AltScreenSearchMatch[] {
	if (!query) return [];
	const expression = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
	const result: AltScreenSearchMatch[] = [];
	let position = 0;
	for (const match of c.text.matchAll(expression)) {
		const start = match.index,
			end = start + match[0].length,
			segments: AltScreenSearchSegment[] = [];
		while (position < c.spans.length && c.spans[position]!.end <= start) position++;
		for (let index = position; index < c.spans.length; index++) {
			const span = c.spans[index]!;
			if (span.start >= end) break;
			if (span.end <= start) continue;
			const from = span.linear ? span.startCol + Math.max(start, span.start) - span.start : span.startCol;
			const to = span.linear ? span.startCol + Math.min(end, span.end) - span.start : span.endCol;
			const previous = segments.at(-1);
			if (previous && previous.row === span.row && from <= previous.endCol)
				previous.endCol = Math.max(previous.endCol, to);
			else segments.push({ row: span.row, startCol: from, endCol: to });
		}
		while (position < c.spans.length && c.spans[position]!.end <= end) position++;
		if (segments.length) result.push({ segments });
	}
	return result;
}
export function findAltScreenSearchMatches(lines: readonly string[], query: string): AltScreenSearchMatch[] {
	return matches(corpus(lines), normalize(query));
}
export function getAltScreenSearchMatchKey(match: AltScreenSearchMatch): string {
	const first = match.segments[0],
		last = match.segments.at(-1);
	return first && last ? `${first.row}:${first.startCol}:${last.row}:${last.endCol}` : "";
}
export class AltScreenSearchIndex {
	#lines: string[] | undefined;
	#corpus: Corpus | undefined;
	#query: string | undefined;
	#matches: AltScreenSearchMatch[] = [];
	search(lines: readonly string[], query: string): AltScreenSearchResult {
		const changedLines =
			!this.#lines || this.#lines.length !== lines.length || lines.some((line, index) => line !== this.#lines![index]);
		if (changedLines || !this.#corpus) {
			this.#lines = Array.from(lines);
			this.#corpus = corpus(lines);
		}
		const normalized = normalize(query),
			changed = changedLines || normalized !== this.#query;
		if (changed) {
			this.#query = normalized;
			this.#matches = matches(this.#corpus, normalized);
		}
		return { matches: this.#matches, changed };
	}
}
export class AltScreenSearchComponent implements Component, Focusable {
	readonly #input = new Input({
		prompt: " ",
		placeholder: "Find in transcript",
		placeholderStyle: (text) => `\x1b[2m${text}\x1b[22m`,
	});
	readonly #change: (query: string) => void;
	readonly #style: (text: string, hovered: boolean) => string;
	#count = 0;
	#index = -1;
	#previous: [number, number] = [-1, -1];
	#next: [number, number] = [-1, -1];
	#hover: -1 | 1 | undefined;
	constructor(
		onQueryChange: (query: string) => void,
		navigationButtonStyle: (text: string, hovered: boolean) => string = (text) => text,
	) {
		this.#change = onQueryChange;
		this.#style = navigationButtonStyle;
	}
	get focused(): boolean {
		return this.#input.focused;
	}
	set focused(value: boolean) {
		this.#input.focused = value;
	}
	setResult(index: number, count: number): void {
		this.#index = index;
		this.#count = count;
	}
	getNavigationDirectionAt(row: number, column: number): -1 | 1 | undefined {
		if (row !== 2) return;
		if (column >= this.#previous[0] && column < this.#previous[1]) return -1;
		if (column >= this.#next[0] && column < this.#next[1]) return 1;
		return;
	}
	setHoveredNavigationDirection(direction: -1 | 1 | undefined): boolean {
		if (direction === this.#hover) return false;
		this.#hover = direction;
		return true;
	}
	handleInput(data: string): void {
		const previous = this.#input.getValue();
		this.#input.handleInput(data);
		const value = this.#input.getValue();
		if (value !== previous) this.#change(value);
	}
	invalidate(): void {
		this.#input.invalidate();
	}
	render(width: number): string[] {
		width = Math.max(1, width);
		const inner = Math.max(0, width - 2);
		const key = (value: string | undefined) =>
			value
				? value
						.split("+")
						.map((part) =>
							process.platform === "darwin" && part.toLowerCase() === "alt"
								? "Option"
								: part.charAt(0).toUpperCase() + part.slice(1),
						)
						.join("+")
				: "Unbound";
		const bindings = getKeybindings(),
			query = this.#input.getValue();
		const result = !query ? "" : this.#count === 0 ? "No matches" : `${this.#index + 1}/${this.#count}`;
		const summary = truncateToWidth(result, Math.max(0, inner - 3), ""),
			label = summary ? `\x1b[2m ${summary} \x1b[22m` : "";
		const inputWidth = Math.max(0, inner - visibleWidth(label)),
			line = truncateToWidth(this.#input.render(Math.max(1, inputWidth))[0] ?? "", inputWidth, "");
		const content = line + " ".repeat(Math.max(0, inputWidth - visibleWidth(line))) + label;
		let previous = `↑ ${key(bindings.getKeys("tui.altScreen.searchPrevious")[0])}`,
			next = `↓ ${key(bindings.getKeys("tui.altScreen.searchNext")[0])}`,
			separator = " · ";
		const available = Math.max(0, inner - 3);
		let controls = visibleWidth(previous) + visibleWidth(separator) + visibleWidth(next);
		if (controls > available) {
			previous = "↑";
			next = "↓";
			separator = " ";
			controls = 3;
		}
		const show = controls <= available,
			buttons = show
				? this.#style(previous, this.#hover === -1) + separator + this.#style(next, this.#hover === 1)
				: "";
		const right = buttons && inner > controls + (show ? 2 : 0) ? 1 : 0,
			left = Math.max(0, inner - (show ? controls + 2 : 0) - right);
		this.#previous = show ? [left + 2, left + 2 + visibleWidth(previous)] : [-1, -1];
		this.#next = show
			? [this.#previous[1] + visibleWidth(separator), this.#previous[1] + visibleWidth(separator) + visibleWidth(next)]
			: [-1, -1];
		return width === 1
			? ["┌", "│", "└"]
			: [
					`┌${"─".repeat(inner)}┐`,
					`│${content}│`,
					`└${"─".repeat(left)}${buttons ? ` ${buttons} ` : ""}${"─".repeat(right)}┘`,
				];
	}
}
