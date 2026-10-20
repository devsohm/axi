import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "../autocomplete.ts";
import { getKeybindings } from "../keybindings.ts";
import { decodePrintableKey, matchesKey } from "../keys.ts";
import { KillRing } from "../kill-ring.ts";
import {
	CURSOR_MARKER,
	renderFakeCursor,
	type Component,
	type Focusable,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "../tui.ts";
import { UndoStack } from "../undo-stack.ts";
import {
	autocompleteBoundaryRegex,
	autocompleteSeparatorRegex,
	cjkBreakRegex,
	getGraphemeSegmenter,
	getWordSegmenter,
	isWhitespaceChar,
	sliceByColumn,
	visibleWidth,
} from "../utils.ts";
import { findWordBackward, findWordForward } from "../word-navigation.ts";
import { SelectList, type SelectListTheme } from "./select-list.ts";
const graphemes = getGraphemeSegmenter(),
	words = getWordSegmenter();
const MARKERS = /\[paste #(\d+)( (\+\d+ lines|\d+ chars))?\]/g;
const MARKER = /^\[paste #(\d+)( (\+\d+ lines|\d+ chars))?\]$/;
const atomic = (text: string) => text.length >= 10 && MARKER.test(text);
export interface TextChunk {
	text: string;
	startIndex: number;
	endIndex: number;
}
export function wordWrapLine(line: string, maxWidth: number, preSegmented?: Intl.SegmentData[]): TextChunk[] {
	if (!line || maxWidth <= 0) return [{ text: "", startIndex: 0, endIndex: 0 }];
	if (visibleWidth(line) <= maxWidth) return [{ text: line, startIndex: 0, endIndex: line.length }];
	const parts = preSegmented ?? [...graphemes.segment(line)],
		chunks: TextChunk[] = [];
	let width = 0,
		start = 0,
		opportunity = -1,
		opportunityWidth = 0;
	for (let index = 0; index < parts.length; index++) {
		const part = parts[index]!,
			text = part.segment,
			size = visibleWidth(text),
			space = !atomic(text) && isWhitespaceChar(text);
		if (width + size > maxWidth) {
			if (opportunity >= 0 && width - opportunityWidth + size <= maxWidth) {
				chunks.push({ text: line.slice(start, opportunity), startIndex: start, endIndex: opportunity });
				start = opportunity;
				width -= opportunityWidth;
			} else if (start < part.index) {
				chunks.push({ text: line.slice(start, part.index), startIndex: start, endIndex: part.index });
				start = part.index;
				width = 0;
			}
			opportunity = -1;
		}
		if (size > maxWidth) {
			const nestedSegments = [...graphemes.segment(text)];
			if (nestedSegments.length === 1) throw new RangeError("Maximum call stack size exceeded");
			const nested = wordWrapLine(text, maxWidth, nestedSegments);
			for (const item of nested.slice(0, -1))
				chunks.push({
					text: item.text,
					startIndex: part.index + item.startIndex,
					endIndex: part.index + item.endIndex,
				});
			const last = nested.at(-1)!;
			start = part.index + last.startIndex;
			width = visibleWidth(last.text);
			opportunity = -1;
			continue;
		}
		width += size;
		const next = parts[index + 1];
		if (
			(next && space && (atomic(next.segment) || !isWhitespaceChar(next.segment))) ||
			(next &&
				!space &&
				!isWhitespaceChar(next.segment) &&
				((!atomic(text) && cjkBreakRegex.test(text)) || (!atomic(next.segment) && cjkBreakRegex.test(next.segment))))
		) {
			opportunity = next!.index;
			opportunityWidth = width;
		}
	}
	chunks.push({ text: line.slice(start), startIndex: start, endIndex: line.length });
	return chunks;
}
interface State {
	lines: string[];
	cursorLine: number;
	cursorCol: number;
}
interface Snapshot {
	state: State;
	pastes: Map<number, string>;
	pasteCounter: number;
}
interface Visual {
	logicalLine: number;
	startCol: number;
	length: number;
}
export interface EditorTheme {
	borderColor: (str: string) => string;
	selectList: SelectListTheme;
}
export interface EditorOptions {
	paddingX?: number;
	autocompleteMaxVisible?: number;
}
function normalized(text: string): string {
	return text.replace(/\r\n?/g, "\n").replace(/\t/g, "    ");
}
function setting(value: number | undefined, fallback: number, min: number, max = Infinity): number {
	return value === undefined || !Number.isFinite(value) ? fallback : Math.max(min, Math.min(max, Math.floor(value)));
}
function scrollBorder(direction: "↑" | "↓", count: number, width: number): string {
	width = Math.max(0, width);
	const label = ` ${direction} ${count} more `,
		size = visibleWidth(label);
	if (size + 2 <= width) {
		const left = Math.floor((width - size) / 2);
		return "─".repeat(left) + label + "─".repeat(width - left - size);
	}
	const short = `─── ${direction} ${count} more `,
		remaining = width - visibleWidth(short);
	if (remaining >= 0) return short + "─".repeat(remaining);
	const ellipsis = "...".slice(0, width);
	return sliceByColumn(short, 0, width - visibleWidth(ellipsis), true) + ellipsis;
}
export class Editor implements Component, Focusable {
	private state: State = { lines: [""], cursorLine: 0, cursorCol: 0 };
	focused = false;
	protected tui: TUI;
	readonly #theme: EditorTheme;
	#padding = 0;
	#maxVisible = 5;
	#width = 80;
	#scroll = 0;
	#visible = 1;
	#menuHeight = 0;
	borderColor: (str: string) => string;
	disableSubmit = false;
	onSubmit?: (text: string) => void;
	onChange?: (text: string) => void;
	#pastes = new Map<number, string>();
	#pasteCounter = 0;
	#paste: string | undefined;
	readonly #history: string[] = [];
	#historyIndex = -1;
	#draft: State | null = null;
	readonly #kills = new KillRing();
	readonly #undo = new UndoStack<Snapshot>();
	#action: "kill" | "yank" | "type-word" | null = null;
	#jump: "forward" | "backward" | null = null;
	#preferred: number | null = null;
	#snapped: number | null = null;
	#provider: AutocompleteProvider | undefined;
	#triggers = ["@", "#"];
	#menu: SelectList | undefined;
	#mode: "regular" | "force" | null = null;
	#prefix = "";
	#abort: AbortController | undefined;
	#debounce: ReturnType<typeof setTimeout> | undefined;
	#task = Promise.resolve();
	#token = 0;
	#request = 0;
	constructor(tui: TUI, theme: EditorTheme, options: EditorOptions = {}) {
		this.tui = tui;
		this.#theme = theme;
		this.borderColor = theme.borderColor;
		this.#padding = setting(options.paddingX, 0, 0);
		this.#maxVisible = setting(options.autocompleteMaxVisible, 5, 3, 20);
	}
	private line(): string {
		return this.state.lines[this.state.cursorLine] ?? "";
	}
	private setCol(col: number): void {
		this.state.cursorCol = col;
		this.#preferred = null;
		this.#snapped = null;
	}
	private changed(): void {
		this.onChange?.(this.getText());
	}
	private remember(): void {
		this.#undo.push({ state: this.state, pastes: this.#pastes, pasteCounter: this.#pasteCounter });
	}
	private exitHistory(): void {
		this.#historyIndex = -1;
		this.#draft = null;
	}
	private segments(text: string, mode: "word" | "grapheme" = "grapheme"): Intl.SegmentData[] {
		const base = (mode === "word" ? words : graphemes).segment(text);
		if (!this.#pastes.size || !text.includes("[paste #")) return [...base];
		const markers = [...text.matchAll(MARKERS)].filter((match) => this.#pastes.has(Number(match[1]))),
			result: Intl.SegmentData[] = [];
		let index = 0;
		for (const part of base) {
			while (index < markers.length && markers[index]!.index + markers[index]![0].length <= part.index) index++;
			const marker = markers[index];
			if (marker && part.index >= marker.index && part.index < marker.index + marker[0].length) {
				if (part.index === marker.index) result.push({ segment: marker[0], index: marker.index, input: text });
			} else result.push(part);
		}
		return result;
	}
	getText(): string {
		return this.state.lines.join("\n");
	}
	getLines(): string[] {
		return [...this.state.lines];
	}
	getCursor(): { line: number; col: number } {
		return { line: this.state.cursorLine, col: this.state.cursorCol };
	}
	getExpandedText(): string {
		let text = this.getText();
		for (const [id, value] of this.#pastes)
			text = text.replace(new RegExp(`\\[paste #${id}( (\\+\\d+ lines|\\d+ chars))?\\]`, "g"), () => value);
		return text;
	}
	private setInternal(text: string, start = false): void {
		this.state.lines = text.split("\n");
		this.state.cursorLine = start ? 0 : this.state.lines.length - 1;
		this.setCol(start ? 0 : this.line().length);
		this.#scroll = 0;
		this.changed();
	}
	setText(text: string): void {
		this.cancelAutocomplete();
		this.#action = null;
		this.exitHistory();
		text = normalized(text);
		if (text !== this.getText()) this.remember();
		this.#pastes.clear();
		this.#pasteCounter = 0;
		this.setInternal(text);
	}
	getPaddingX(): number {
		return this.#padding;
	}
	setPaddingX(padding: number): void {
		const next = setting(padding, 0, 0);
		if (next !== this.#padding) {
			this.#padding = next;
			this.tui.requestRender();
		}
	}
	getAutocompleteMaxVisible(): number {
		return this.#maxVisible;
	}
	setAutocompleteMaxVisible(maxVisible: number): void {
		const next = setting(maxVisible, 5, 3, 20);
		if (next !== this.#maxVisible) {
			this.#maxVisible = next;
			this.tui.requestRender();
		}
	}
	setAutocompleteProvider(provider: AutocompleteProvider): void {
		this.cancelAutocomplete();
		this.#provider = provider;
		this.#triggers = ["@", "#"];
		for (const char of provider.triggerCharacters ?? [])
			if (char.length === 1 && char !== "/" && !isWhitespaceChar(char) && !this.#triggers.includes(char))
				this.#triggers.push(char);
	}
	addToHistory(text: string): void {
		text = text.trim();
		if (!text || this.#history[0] === text) return;
		this.#history.unshift(text);
		if (this.#history.length > 100) this.#history.pop();
	}
	private history(direction: -1 | 1): void {
		this.#action = null;
		if (!this.#history.length) return;
		const next = this.#historyIndex - direction;
		if (next < -1 || next >= this.#history.length) return;
		if (this.#historyIndex === -1 && next >= 0) {
			this.remember();
			this.#draft = structuredClone(this.state);
		}
		this.#historyIndex = next;
		if (next < 0) {
			const draft = this.#draft;
			this.#draft = null;
			if (draft) {
				this.state = draft;
				this.#preferred = null;
				this.#snapped = null;
				this.#scroll = 0;
				this.changed();
			} else this.setInternal("");
		} else this.setInternal(this.#history[next] ?? "", direction < 0);
	}
	private insert(text: string): void {
		if (!text) return;
		text = normalized(text);
		const lines = text.split("\n"),
			before = this.line().slice(0, this.state.cursorCol),
			after = this.line().slice(this.state.cursorCol);
		this.state.lines.splice(
			this.state.cursorLine,
			1,
			...(lines.length === 1
				? [before + text + after]
				: [before + lines[0], ...lines.slice(1, -1), lines.at(-1)! + after]),
		);
		const col = lines.length === 1 ? this.state.cursorCol + text.length : lines.at(-1)!.length;
		this.state.cursorLine += lines.length - 1;
		this.setCol(col);
		this.changed();
	}
	insertTextAtCursor(text: string): void {
		if (!text) return;
		this.cancelAutocomplete();
		this.remember();
		this.#action = null;
		this.exitHistory();
		this.insert(text);
	}
	private visual(width = this.#width): Visual[] {
		return this.state.lines.flatMap((line, logicalLine) =>
			wordWrapLine(line, width, this.segments(line)).map((chunk) => ({
				logicalLine,
				startCol: chunk.startIndex,
				length: chunk.endIndex - chunk.startIndex,
			})),
		);
	}
	private visualIndex(lines: Visual[], line = this.state.cursorLine, col = this.state.cursorCol): number {
		const found = lines.findIndex(
			(item, index) =>
				item.logicalLine === line &&
				col >= item.startCol &&
				(col < item.startCol + item.length ||
					(col === item.startCol + item.length &&
						(index === lines.length - 1 || lines[index + 1]?.logicalLine !== line))),
		);
		return found < 0 ? lines.length - 1 : found;
	}
	invalidate(): void {}
	protected renderTopBorder(width: number, hidden: number): string {
		return this.borderColor(hidden > 0 ? scrollBorder("↑", hidden, width) : "─".repeat(width));
	}
	protected renderBottomBorder(width: number, hidden: number): string {
		return this.borderColor(hidden > 0 ? scrollBorder("↓", hidden, width) : "─".repeat(width));
	}
	render(width: number): string[] {
		const padding = Math.min(this.#padding, Math.max(0, Math.floor((width - 1) / 2))),
			content = Math.max(1, width - 2 * padding);
		this.#width = Math.max(1, content - (padding ? 0 : 1));
		const layout = this.visual(),
			cursorIndex = this.visualIndex(layout),
			maximum = Math.max(5, Math.floor(this.tui.terminal.rows * 0.3));
		if (cursorIndex < this.#scroll) this.#scroll = cursorIndex;
		else if (cursorIndex >= this.#scroll + maximum) this.#scroll = cursorIndex - maximum + 1;
		this.#scroll = Math.max(0, Math.min(this.#scroll, Math.max(0, layout.length - maximum)));
		const visible = layout.slice(this.#scroll, this.#scroll + maximum);
		this.#visible = visible.length;
		const pad = " ".repeat(padding),
			result = [this.renderTopBorder(width, this.#scroll)];
		for (const [itemIndex, item] of visible.entries()) {
			let text = this.state.lines[item.logicalLine]!.slice(item.startCol, item.startCol + item.length),
				size = visibleWidth(text),
				cursorInPadding = false;
			if (this.#scroll + itemIndex === cursorIndex) {
				const offset = this.state.cursorCol - item.startCol,
					before = text.slice(0, offset),
					after = text.slice(offset),
					marker = this.focused ? CURSOR_MARKER : "";
				if (after) {
					const first = this.segments(after)[0]?.segment ?? "";
					text = before + marker + renderFakeCursor(first) + after.slice(first.length);
				} else {
					text = before + marker + renderFakeCursor(" ");
					size++;
					cursorInPadding = size > content && padding > 0;
				}
			}
			result.push(pad + text + " ".repeat(Math.max(0, content - size)) + (cursorInPadding ? pad.slice(1) : pad));
		}
		result.push(this.renderBottomBorder(width, layout.length - this.#scroll - visible.length));
		this.#menuHeight = 0;
		if (this.#mode && this.#menu) {
			const lines = this.#menu.render(content);
			this.#menuHeight = lines.length;
			for (const line of lines) result.push(pad + line + " ".repeat(Math.max(0, content - visibleWidth(line))) + pad);
		}
		return result;
	}
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const menuStart = this.#visible + 2,
			padding = Math.min(this.#padding, Math.max(0, Math.floor((event.width - 1) / 2)));
		if (this.#mode && this.#menu && event.y >= menuStart && event.y < menuStart + this.#menuHeight) {
			const result = this.#menu.handleMouse?.({
				...event,
				x: event.x - padding,
				y: event.y - menuStart,
				width: Math.max(1, event.width - 2 * padding),
				height: this.#menuHeight,
			});
			return result ? { ...result, focus: true } : undefined;
		}
		if (event.type !== "click" || event.button !== "left") return;
		if (event.y <= 0 || event.y > this.#visible) return { handled: true, focus: true };
		const lines = this.visual(),
			index = this.#scroll + event.y - 1,
			item = lines[index];
		if (!item) return { handled: true, focus: true };
		const chunk = this.state.lines[item.logicalLine]!.slice(item.startCol, item.startCol + item.length),
			target = Math.max(0, event.x - padding);
		let column = 0,
			offset = chunk.length,
			last = 0;
		for (const part of this.segments(chunk)) {
			const next = column + visibleWidth(part.segment);
			last = part.index;
			if (target < next) {
				offset = part.index;
				break;
			}
			column = next;
		}
		const lastChunk = index === lines.length - 1 || lines[index + 1]?.logicalLine !== item.logicalLine;
		if (!lastChunk && offset === chunk.length && chunk.length) offset = last;
		this.state.cursorLine = item.logicalLine;
		this.setCol(item.startCol + offset);
		this.#action = null;
		this.exitHistory();
		if (this.#mode) this.requestAutocomplete(this.#mode === "force", false);
		return { handled: true, focus: true };
	}
	private absolute(): number {
		return (
			this.state.lines.slice(0, this.state.cursorLine).reduce((sum, line) => sum + line.length + 1, 0) +
			this.state.cursorCol
		);
	}
	private erase(start: number, end: number): void {
		const text = this.getText(),
			before = text.slice(0, start),
			after = text.slice(end),
			lines = before.split("\n");
		this.state.lines = (before + after).split("\n");
		this.state.cursorLine = lines.length - 1;
		this.setCol(lines.at(-1)!.length);
	}
	private delete(direction: -1 | 1, unit: "char" | "word" | "line"): void {
		this.exitHistory();
		const line = this.line(),
			col = this.state.cursorCol,
			absolute = this.absolute();
		let start = absolute,
			end = absolute;
		const kill = unit !== "char";
		if (!kill) this.#action = null;
		if (direction < 0) {
			if (col === 0) {
				if (this.state.cursorLine > 0) start--;
			} else if (unit === "line") start -= col;
			else if (unit === "word")
				start -=
					col -
					findWordBackward(line, col, { segment: (text) => this.segments(text, "word"), isAtomicSegment: atomic });
			else start -= this.segments(line.slice(0, col)).at(-1)?.segment.length ?? 1;
		} else {
			if (col >= line.length) {
				if (this.state.cursorLine < this.state.lines.length - 1) end++;
			} else if (unit === "line") end += line.length - col;
			else if (unit === "word")
				end +=
					findWordForward(line, col, { segment: (text) => this.segments(text, "word"), isAtomicSegment: atomic }) - col;
			else end += this.segments(line.slice(col))[0]?.segment.length ?? 1;
		}
		if (start !== end) {
			this.remember();
			if (kill) {
				this.#kills.push(this.getText().slice(start, end), {
					prepend: direction < 0,
					accumulate: this.#action === "kill",
				});
				this.#action = "kill";
			} else if (direction < 0 && col > 0) {
				const match = MARKER.exec(this.segments(line.slice(0, col)).at(-1)?.segment ?? "");
				if (match) {
					const removed = Number(match[1]);
					this.#pastes.delete(removed);
					this.#pasteCounter--;
					for (const id of [...this.#pastes.keys()].filter((id) => id > removed).sort((a, b) => a - b)) {
						this.#pastes.set(id - 1, this.#pastes.get(id)!);
						this.#pastes.delete(id);
					}
					this.state.lines = this.state.lines.map((line) =>
						line.replace(MARKERS, (whole, id: string, suffix: string) =>
							Number(id) > removed ? `[paste #${Number(id) - 1}${suffix}]` : whole,
						),
					);
				}
			}
			this.erase(start, end);
		}
		this.changed();
		if (unit === "char") this.refreshAutocomplete();
	}
	private horizontal(direction: -1 | 1, word = false): void {
		this.#action = null;
		const line = this.line(),
			col = this.state.cursorCol;
		if (direction < 0) {
			if (col > 0)
				this.setCol(
					word
						? findWordBackward(line, col, { segment: (text) => this.segments(text, "word"), isAtomicSegment: atomic })
						: col - (this.segments(line.slice(0, col)).at(-1)?.segment.length ?? 1),
				);
			else if (this.state.cursorLine > 0) {
				this.state.cursorLine--;
				this.setCol(this.line().length);
			}
		} else {
			if (col < line.length)
				this.setCol(
					word
						? findWordForward(line, col, { segment: (text) => this.segments(text, "word"), isAtomicSegment: atomic })
						: col + (this.segments(line.slice(col))[0]?.segment.length ?? 1),
				);
			else if (this.state.cursorLine < this.state.lines.length - 1) {
				this.state.cursorLine++;
				this.setCol(0);
			} else if (!word) {
				const visual = this.visual(),
					current = visual[this.visualIndex(visual)];
				if (current) this.#preferred = col - current.startCol;
			}
		}
		if (!word && this.#mode) this.requestAutocomplete(this.#mode === "force", false);
	}
	private vertical(target: number, lines = this.visual(), current = this.visualIndex(lines)): void {
		const from = lines[current],
			to = lines[target];
		if (!from || !to) return;
		const sourceOffset =
			this.#snapped !== null
				? this.#snapped - lines[this.visualIndex(lines, from.logicalLine, this.#snapped)]!.startCol
				: this.state.cursorCol - from.startCol;
		const sourceMax =
			current === lines.length - 1 || lines[current + 1]?.logicalLine !== from.logicalLine
				? from.length
				: Math.max(0, from.length - 1);
		const targetMax =
			target === lines.length - 1 || lines[target + 1]?.logicalLine !== to.logicalLine
				? to.length
				: Math.max(0, to.length - 1);
		let column: number;
		if (this.#preferred === null || sourceOffset < sourceMax) {
			if (targetMax < sourceOffset) {
				this.#preferred = sourceOffset;
				column = targetMax;
			} else {
				this.#preferred = null;
				column = sourceOffset;
			}
		} else if (targetMax < sourceOffset || targetMax < this.#preferred) column = targetMax;
		else {
			column = this.#preferred;
			this.#preferred = null;
		}
		this.state.cursorLine = to.logicalLine;
		this.state.cursorCol = Math.min(to.startCol + column, this.line().length);
		for (const part of this.segments(this.line())) {
			if (part.index > this.state.cursorCol) break;
			if (part.segment.length <= 1 || this.state.cursorCol >= part.index + part.segment.length) continue;
			if (part.index < to.startCol && target > current) {
				let next = target + 1;
				while (
					next < lines.length &&
					lines[next]!.logicalLine === to.logicalLine &&
					lines[next]!.startCol < part.index + part.segment.length
				)
					next++;
				if (next < lines.length) {
					this.vertical(next, lines, current);
					return;
				}
			}
			this.#snapped = this.state.cursorCol;
			this.state.cursorCol = part.index;
			return;
		}
		this.#snapped = null;
	}
	private moveVertical(direction: -1 | 1, page = false): void {
		this.#action = null;
		const lines = this.visual(),
			current = this.visualIndex(lines);
		if (page) {
			this.vertical(
				Math.max(
					0,
					Math.min(lines.length - 1, current + direction * Math.max(5, Math.floor(this.tui.terminal.rows * 0.3))),
				),
				lines,
				current,
			);
			return;
		}
		if (direction < 0 && current === 0) {
			if (this.getText() === "" || this.#historyIndex >= 0 || this.state.cursorCol === 0) this.history(-1);
			else this.setCol(0);
			return;
		}
		if (direction > 0 && current === lines.length - 1) {
			if (this.#historyIndex >= 0) this.history(1);
			else this.setCol(this.line().length);
			return;
		}
		this.vertical(current + direction, lines, current);
		if (this.#mode) this.requestAutocomplete(this.#mode === "force", false);
	}
	private newline(): void {
		this.cancelAutocomplete();
		this.exitHistory();
		this.#action = null;
		this.remember();
		this.insert("\n");
	}
	private type(text: string): void {
		this.exitHistory();
		if (isWhitespaceChar(text) || this.#action !== "type-word") this.remember();
		this.#action = "type-word";
		const line = this.line(),
			col = this.state.cursorCol;
		this.state.lines[this.state.cursorLine] = line.slice(0, col) + text + line.slice(col);
		this.setCol(col + text.length);
		this.changed();
		if (this.#mode) this.requestAutocomplete(this.#mode === "force", false);
		else if (
			(text === "/" &&
				this.state.cursorLine === 0 &&
				["", "/"].includes(this.line().slice(0, this.state.cursorCol).trim())) ||
			(this.#triggers.includes(text) && this.triggerContext()) ||
			((/[a-zA-Z0-9.\-_]/.test(text) || cjkBreakRegex.test(text)) && (this.slashContext() || this.triggerContext()))
		)
			this.requestAutocomplete(false, false);
	}
	private paste(text: string): void {
		this.cancelAutocomplete();
		this.exitHistory();
		this.#action = null;
		this.remember();
		text = normalized(
			text.replace(/\x1b\[(\d+);5u/g, (whole, code: string) => {
				const point = Number(code);
				return point >= 97 && point <= 122
					? String.fromCharCode(point - 96)
					: point >= 65 && point <= 90
						? String.fromCharCode(point - 64)
						: whole;
			}),
		)
			.split("")
			.filter((char) => char === "\n" || char.charCodeAt(0) >= 32)
			.join("");
		const previous = this.state.cursorCol > 0 ? this.line()[this.state.cursorCol - 1] : "";
		if (/^[/~.]/.test(text) && previous && /\w/.test(previous)) text = " " + text;
		const count = text.split("\n").length;
		if (count > 10 || text.length > 1000) {
			const id = ++this.#pasteCounter;
			this.#pastes.set(id, text);
			this.insert(`[paste #${id} ${count > 10 ? `+${count} lines` : `${text.length} chars`}]`);
		} else this.insert(text);
	}
	private submit(): void {
		this.cancelAutocomplete();
		const text = this.getExpandedText().trim();
		this.state = { lines: [""], cursorLine: 0, cursorCol: 0 };
		this.#pastes.clear();
		this.#pasteCounter = 0;
		this.exitHistory();
		this.#scroll = 0;
		this.#undo.clear();
		this.#action = null;
		this.changed();
		this.onSubmit?.(text);
	}
	private undo(): void {
		this.exitHistory();
		const snapshot = this.#undo.pop();
		if (!snapshot) return;
		Object.assign(this.state, snapshot.state);
		this.#pastes = snapshot.pastes;
		this.#pasteCounter = snapshot.pasteCounter;
		this.#action = null;
		this.#preferred = null;
		this.changed();
	}
	private yank(rotate = false): void {
		if (!this.#kills.length || (rotate && (this.#action !== "yank" || this.#kills.length <= 1))) return;
		this.remember();
		if (rotate) {
			const previous = this.#kills.peek()!;
			const end = this.absolute();
			this.erase(end - previous.length, end);
			this.changed();
			this.#kills.rotate();
		}
		this.exitHistory();
		this.insert(this.#kills.peek()!);
		this.#action = "yank";
	}
	private jump(text: string, direction: "forward" | "backward"): void {
		this.#action = null;
		const forward = direction === "forward",
			origin = this.state.cursorLine;
		for (let index = origin; index >= 0 && index < this.state.lines.length; index += forward ? 1 : -1) {
			const line = this.state.lines[index]!,
				from = index === origin ? this.state.cursorCol + (forward ? 1 : -1) : undefined,
				found = forward ? line.indexOf(text, from) : line.lastIndexOf(text, from);
			if (found >= 0) {
				this.state.cursorLine = index;
				this.setCol(found);
				return;
			}
		}
	}
	handleInput(data: string): void {
		const keys = getKeybindings();
		if (this.#jump) {
			if (keys.matches(data, "tui.editor.jumpForward") || keys.matches(data, "tui.editor.jumpBackward")) {
				this.#jump = null;
				return;
			}
			const printable = decodePrintableKey(data) ?? (data.charCodeAt(0) >= 32 ? data : undefined),
				direction = this.#jump;
			this.#jump = null;
			if (printable !== undefined) {
				this.jump(printable, direction);
				return;
			}
		}
		if (data.includes("\x1b[200~")) {
			this.#paste = "";
			data = data.replace("\x1b[200~", "");
		}
		if (this.#paste !== undefined) {
			this.#paste += data;
			const end = this.#paste.indexOf("\x1b[201~");
			if (end >= 0) {
				const text = this.#paste.slice(0, end),
					after = this.#paste.slice(end + 6);
				if (text) this.paste(text);
				this.#paste = undefined;
				if (after) this.handleInput(after);
			}
			return;
		}
		if (keys.matches(data, "tui.input.copy")) return;
		if (keys.matches(data, "tui.editor.undo")) {
			this.undo();
			return;
		}
		if (this.#mode && this.#menu) {
			if (keys.matches(data, "tui.select.cancel")) {
				this.cancelAutocomplete();
				return;
			}
			if (keys.matches(data, "tui.select.up") || keys.matches(data, "tui.select.down")) {
				this.#menu.handleInput(data);
				return;
			}
			if (keys.matches(data, "tui.input.tab")) {
				const selected = this.#menu.getSelectedItem();
				if (selected && this.#provider) this.complete(selected, this.#prefix, true);
				return;
			}
			if (keys.matches(data, "tui.select.confirm")) {
				const selected = this.#menu.getSelectedItem();
				if (selected && this.#provider) {
					const command = this.#prefix.startsWith("/");
					this.complete(selected, this.#prefix, !command);
					if (!command) return;
				}
			}
		}
		if (keys.matches(data, "tui.input.tab") && !this.#mode) {
			if (!this.#provider) return;
			const before = this.line().slice(0, this.state.cursorCol);
			this.requestAutocomplete(!(this.slashContext() && !before.trimStart().includes(" ")), true);
			return;
		}
		const deletion = [
			["tui.editor.deleteToLineEnd", 1, "line"],
			["tui.editor.deleteToLineStart", -1, "line"],
			["tui.editor.deleteWordBackward", -1, "word"],
			["tui.editor.deleteWordForward", 1, "word"],
			["tui.editor.deleteCharBackward", -1, "char"],
			["tui.editor.deleteCharForward", 1, "char"],
		] as const;
		for (const [key, direction, unit] of deletion)
			if (keys.matches(data, key)) {
				this.delete(direction, unit);
				return;
			}
		if (matchesKey(data, "shift+backspace")) {
			this.delete(-1, "char");
			return;
		}
		if (matchesKey(data, "shift+delete")) {
			this.delete(1, "char");
			return;
		}
		if (keys.matches(data, "tui.editor.yank")) {
			this.yank();
			return;
		}
		if (keys.matches(data, "tui.editor.yankPop")) {
			this.yank(true);
			return;
		}
		if (keys.matches(data, "tui.editor.historyPrevious") || keys.matches(data, "tui.editor.historyNext")) {
			this.cancelAutocomplete();
			this.history(keys.matches(data, "tui.editor.historyPrevious") ? -1 : 1);
			return;
		}
		if (keys.matches(data, "tui.editor.cursorLineStart")) {
			this.#action = null;
			this.setCol(0);
			return;
		}
		if (keys.matches(data, "tui.editor.cursorLineEnd")) {
			this.#action = null;
			this.setCol(this.line().length);
			return;
		}
		if (keys.matches(data, "tui.editor.cursorWordLeft")) {
			this.horizontal(-1, true);
			return;
		}
		if (keys.matches(data, "tui.editor.cursorWordRight")) {
			this.horizontal(1, true);
			return;
		}
		const newLine =
			keys.matches(data, "tui.input.newLine") ||
			(data.charCodeAt(0) === 10 && data.length > 1) ||
			data === "\x1b\r" ||
			data === "\x1b[13;2~" ||
			(data.length > 1 && data.includes("\x1b") && data.includes("\r")) ||
			data === "\n";
		if (newLine) {
			const submitKeys = keys.getKeys("tui.input.submit");
			if (
				!this.disableSubmit &&
				matchesKey(data, "enter") &&
				(submitKeys.includes("shift+enter") || submitKeys.includes("shift+return")) &&
				this.state.cursorCol > 0 &&
				this.line()[this.state.cursorCol - 1] === "\\"
			) {
				this.delete(-1, "char");
				this.submit();
			} else this.newline();
			return;
		}
		if (keys.matches(data, "tui.input.submit")) {
			if (this.disableSubmit) return;
			if (this.state.cursorCol > 0 && this.line()[this.state.cursorCol - 1] === "\\") {
				this.delete(-1, "char");
				this.newline();
			} else this.submit();
			return;
		}
		if (keys.matches(data, "tui.editor.cursorUp")) {
			this.moveVertical(-1);
			return;
		}
		if (keys.matches(data, "tui.editor.cursorDown")) {
			this.moveVertical(1);
			return;
		}
		if (keys.matches(data, "tui.editor.cursorLeft")) {
			this.horizontal(-1);
			return;
		}
		if (keys.matches(data, "tui.editor.cursorRight")) {
			this.horizontal(1);
			return;
		}
		if (keys.matches(data, "tui.editor.pageUp")) {
			this.moveVertical(-1, true);
			return;
		}
		if (keys.matches(data, "tui.editor.pageDown")) {
			this.moveVertical(1, true);
			return;
		}
		if (keys.matches(data, "tui.editor.jumpForward")) {
			this.#jump = "forward";
			return;
		}
		if (keys.matches(data, "tui.editor.jumpBackward")) {
			this.#jump = "backward";
			return;
		}
		if (matchesKey(data, "shift+space")) {
			this.type(" ");
			return;
		}
		const printable = decodePrintableKey(data);
		if (printable !== undefined) {
			this.type(printable);
			return;
		}
		if (data.charCodeAt(0) >= 32) this.type(data);
	}
	private slashContext(): boolean {
		return this.state.cursorLine === 0 && this.line().slice(0, this.state.cursorCol).trimStart().startsWith("/");
	}
	private triggerContext(): boolean {
		const trigger = this.#triggers.map((char) => char.replace(/[\\^$.*+?()[\]{}|-]/g, "\\$&")).join("");
		const source = `${autocompleteBoundaryRegex.source}[([{<\x60]*(?:@"[^"]*|[${trigger}](?:(?!${autocompleteSeparatorRegex.source}).)*)$`;
		return new RegExp(source, "u").test(this.line().slice(0, this.state.cursorCol));
	}
	private refreshAutocomplete(): void {
		if (this.#mode) this.requestAutocomplete(this.#mode === "force", false);
		else if (this.slashContext() || this.triggerContext()) this.requestAutocomplete(false, false);
	}
	private cancelRequest(): void {
		this.#token++;
		if (this.#debounce) clearTimeout(this.#debounce);
		this.#debounce = undefined;
		this.#abort?.abort();
		this.#abort = undefined;
	}
	private cancelAutocomplete(): void {
		this.cancelRequest();
		this.#mode = null;
		this.#menu = undefined;
		this.#prefix = "";
	}
	isShowingAutocomplete(): boolean {
		return this.#mode !== null;
	}
	private complete(item: AutocompleteItem, prefix: string, notify: boolean, cancel = true): void {
		if (!this.#provider) return;
		this.remember();
		this.#action = null;
		const result = this.#provider.applyCompletion(
			this.state.lines,
			this.state.cursorLine,
			this.state.cursorCol,
			item,
			prefix,
		);
		this.state.lines = result.lines;
		this.state.cursorLine = result.cursorLine;
		this.setCol(result.cursorCol);
		if (cancel) this.cancelAutocomplete();
		if (notify) this.changed();
	}
	private requestAutocomplete(force: boolean, explicitTab: boolean): void {
		const provider = this.#provider;
		if (!provider) return;
		if (
			force &&
			provider.shouldTriggerFileCompletion &&
			!provider.shouldTriggerFileCompletion(this.state.lines, this.state.cursorLine, this.state.cursorCol)
		)
			return;
		this.cancelRequest();
		const token = ++this.#token;
		const run = () => {
			const previous = this.#task;
			this.#task = (async () => {
				await previous;
				if (token !== this.#token || !this.#provider) return;
				const controller = new AbortController();
				this.#abort = controller;
				const request = ++this.#request,
					text = this.getText(),
					line = this.state.cursorLine,
					col = this.state.cursorCol;
				const suggestions = await this.#provider.getSuggestions(this.state.lines, line, col, {
					signal: controller.signal,
					force,
				});
				if (
					controller.signal.aborted ||
					request !== this.#request ||
					text !== this.getText() ||
					line !== this.state.cursorLine ||
					col !== this.state.cursorCol
				)
					return;
				this.#abort = undefined;
				if (!suggestions || !Array.isArray(suggestions.items) || !suggestions.items.length) {
					this.cancelAutocomplete();
					this.tui.requestRender();
					return;
				}
				if (force && explicitTab && suggestions.items.length === 1) {
					this.complete(suggestions.items[0]!, suggestions.prefix, true, false);
					this.tui.requestRender();
					return;
				}
				this.showSuggestions(suggestions, force ? "force" : "regular");
				this.tui.requestRender();
			})();
		};
		if (!explicitTab && !force && this.triggerContext()) {
			this.#debounce = setTimeout(() => {
				this.#debounce = undefined;
				run();
			}, 20);
		} else run();
	}
	private showSuggestions(suggestions: AutocompleteSuggestions, mode: "regular" | "force"): void {
		this.#prefix = suggestions.prefix;
		const list = new SelectList(
			suggestions.items,
			this.#maxVisible,
			this.#theme.selectList,
			suggestions.prefix.startsWith("/") ? { minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 32 } : undefined,
		);
		list.onSelect = (item) => this.complete(item, this.#prefix, true);
		let index = suggestions.prefix ? suggestions.items.findIndex((item) => item.value === suggestions.prefix) : -1;
		if (index < 0 && suggestions.prefix)
			index = suggestions.items.findIndex((item) => item.value.startsWith(suggestions.prefix));
		if (index >= 0) list.setSelectedIndex(index);
		this.#menu = list;
		this.#mode = mode;
	}
}
