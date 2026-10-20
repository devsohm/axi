import { getKeybindings } from "../keybindings.ts";
import { decodeKittyPrintable } from "../keys.ts";
import { KillRing } from "../kill-ring.ts";
import {
	type Component,
	CURSOR_MARKER,
	renderFakeCursor,
	type Focusable,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "../tui.ts";
import { UndoStack } from "../undo-stack.ts";
import { getGraphemeSegmenter, isWhitespaceChar, sliceByColumn, truncateToWidth, visibleWidth } from "../utils.ts";
import { findWordBackward, findWordForward } from "../word-navigation.ts";

export interface InputOptions {
	prompt?: string;
	placeholder?: string;
	placeholderStyle?: (text: string) => string;
}
interface Snapshot {
	value: string;
	cursor: number;
}

export class Input implements Component, Focusable {
	focused = false;
	onSubmit?: (value: string) => void;
	onEscape?: () => void;
	#value = "";
	#cursor = 0;
	#startColumn = 0;
	#paste: string | undefined;
	#action: "kill" | "yank" | "word" | undefined;
	readonly #kills = new KillRing();
	readonly #undo = new UndoStack<Snapshot>();
	readonly #prompt: string;
	readonly #placeholder: string;
	readonly #placeholderStyle: (text: string) => string;

	constructor(options: InputOptions = {}) {
		this.#prompt = options.prompt ?? "> ";
		this.#placeholder = options.placeholder ?? "";
		this.#placeholderStyle = options.placeholderStyle ?? ((text) => text);
	}
	getValue(): string {
		return this.#value;
	}
	setValue(value: string): void {
		this.#value = value;
		this.#cursor = Math.min(this.#cursor, value.length);
	}
	invalidate(): void {}
	#remember(): void {
		this.#undo.push({ value: this.#value, cursor: this.#cursor });
	}
	#insert(text: string): void {
		this.#value = this.#value.slice(0, this.#cursor) + text + this.#value.slice(this.#cursor);
		this.#cursor += text.length;
	}
	#previous(): number {
		return (
			this.#cursor -
			([...getGraphemeSegmenter().segment(this.#value.slice(0, this.#cursor))].at(-1)?.segment.length ?? 1)
		);
	}
	#next(): number {
		return (
			this.#cursor +
			(getGraphemeSegmenter().segment(this.#value.slice(this.#cursor))[Symbol.iterator]().next().value?.segment
				.length ?? 1)
		);
	}
	#erase(start: number, end: number, kill: boolean): void {
		if (start === end) return;
		this.#remember();
		if (kill)
			this.#kills.push(this.#value.slice(start, end), {
				prepend: start < this.#cursor,
				accumulate: this.#action === "kill",
			});
		this.#action = kill ? "kill" : undefined;
		this.#value = this.#value.slice(0, start) + this.#value.slice(end);
		this.#cursor = start;
	}

	handleInput(data: string): void {
		if (data.includes("\x1b[200~")) {
			this.#paste = "";
			data = data.replace("\x1b[200~", "");
		}
		if (this.#paste !== undefined) {
			this.#paste += data;
			const end = this.#paste.indexOf("\x1b[201~");
			if (end < 0) return;
			const text = this.#paste.slice(0, end),
				remaining = this.#paste.slice(end + 6);
			this.#paste = undefined;
			this.#action = undefined;
			this.#remember();
			this.#insert(text.replace(/[\r\n]/g, "").replace(/\t/g, "    "));
			if (remaining) this.handleInput(remaining);
			return;
		}
		const bindings = getKeybindings();
		if (bindings.matches(data, "tui.select.cancel")) {
			this.onEscape?.();
			return;
		}
		if (bindings.matches(data, "tui.editor.undo")) {
			const snapshot = this.#undo.pop();
			if (snapshot) {
				this.#value = snapshot.value;
				this.#cursor = snapshot.cursor;
				this.#action = undefined;
			}
			return;
		}
		if (bindings.matches(data, "tui.input.submit") || data === "\n") {
			this.onSubmit?.(this.#value);
			return;
		}
		if (bindings.matches(data, "tui.editor.deleteCharBackward")) {
			this.#action = undefined;
			if (this.#cursor > 0) this.#erase(this.#previous(), this.#cursor, false);
			return;
		}
		if (bindings.matches(data, "tui.editor.deleteCharForward")) {
			this.#action = undefined;
			if (this.#cursor < this.#value.length) this.#erase(this.#cursor, this.#next(), false);
			return;
		}
		if (bindings.matches(data, "tui.editor.deleteWordBackward")) {
			if (this.#cursor > 0) this.#erase(findWordBackward(this.#value, this.#cursor), this.#cursor, true);
			return;
		}
		if (bindings.matches(data, "tui.editor.deleteWordForward")) {
			if (this.#cursor < this.#value.length)
				this.#erase(this.#cursor, findWordForward(this.#value, this.#cursor), true);
			return;
		}
		if (bindings.matches(data, "tui.editor.deleteToLineStart")) {
			this.#erase(0, this.#cursor, true);
			return;
		}
		if (bindings.matches(data, "tui.editor.deleteToLineEnd")) {
			this.#erase(this.#cursor, this.#value.length, true);
			return;
		}
		if (bindings.matches(data, "tui.editor.yank")) {
			const text = this.#kills.peek();
			if (text) {
				this.#remember();
				this.#insert(text);
				this.#action = "yank";
			}
			return;
		}
		if (bindings.matches(data, "tui.editor.yankPop")) {
			if (this.#action === "yank" && this.#kills.length > 1) {
				this.#remember();
				const start = this.#cursor - (this.#kills.peek()?.length ?? 0);
				this.#value = this.#value.slice(0, start) + this.#value.slice(this.#cursor);
				this.#cursor = start;
				this.#kills.rotate();
				this.#insert(this.#kills.peek() ?? "");
			}
			return;
		}
		if (bindings.matches(data, "tui.editor.cursorLeft")) {
			this.#action = undefined;
			if (this.#cursor > 0) this.#cursor = this.#previous();
			return;
		}
		if (bindings.matches(data, "tui.editor.cursorRight")) {
			this.#action = undefined;
			if (this.#cursor < this.#value.length) this.#cursor = this.#next();
			return;
		}
		if (bindings.matches(data, "tui.editor.cursorLineStart")) {
			this.#action = undefined;
			this.#cursor = 0;
			return;
		}
		if (bindings.matches(data, "tui.editor.cursorLineEnd")) {
			this.#action = undefined;
			this.#cursor = this.#value.length;
			return;
		}
		if (bindings.matches(data, "tui.editor.cursorWordLeft")) {
			if (this.#cursor > 0) {
				this.#action = undefined;
				this.#cursor = findWordBackward(this.#value, this.#cursor);
			}
			return;
		}
		if (bindings.matches(data, "tui.editor.cursorWordRight")) {
			if (this.#cursor < this.#value.length) {
				this.#action = undefined;
				this.#cursor = findWordForward(this.#value, this.#cursor);
			}
			return;
		}
		const decoded = decodeKittyPrintable(data);
		const text = decoded ?? data;
		if (decoded === undefined && /[\x00-\x1f\x7f-\x9f]/.test(data)) return;
		if (isWhitespaceChar(text) || this.#action !== "word") this.#remember();
		this.#action = "word";
		this.#insert(text);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "press" || event.button !== "left" || event.y !== 0) return undefined;
		const target = this.#startColumn + Math.max(0, event.x - 2);
		let position = 0;
		this.#cursor = this.#value.length;
		for (const part of getGraphemeSegmenter().segment(this.#value)) {
			const end = position + visibleWidth(part.segment);
			if (target < end) {
				this.#cursor = part.index;
				break;
			}
			position = end;
		}
		this.#action = undefined;
		return { handled: true, focus: true };
	}

	render(width: number): string[] {
		const available = width - visibleWidth(this.#prompt);
		if (available <= 0) return [truncateToWidth(this.#prompt, width, "")];
		const marker = this.focused ? CURSOR_MARKER : "";
		if (!this.#value && this.#placeholder) {
			const text = truncateToWidth(this.#placeholder, available, "");
			const first = getGraphemeSegmenter().segment(text)[Symbol.iterator]().next().value?.segment ?? " ";
			const painted =
				marker + renderFakeCursor(this.#placeholderStyle(first)) + this.#placeholderStyle(text.slice(first.length));
			return [this.#prompt + painted + " ".repeat(Math.max(0, available - visibleWidth(painted)))];
		}
		let text = this.#value,
			cursor = this.#cursor;
		this.#startColumn = 0;
		const total = visibleWidth(text);
		if (total >= available) {
			const window = this.#cursor === this.#value.length ? available - 1 : available;
			if (window > 0) {
				const cursorColumn = visibleWidth(this.#value.slice(0, this.#cursor));
				const half = Math.floor(window / 2);
				this.#startColumn =
					cursorColumn < half
						? 0
						: cursorColumn > total - half
							? Math.max(0, total - window)
							: Math.max(0, cursorColumn - half);
				text = sliceByColumn(this.#value, this.#startColumn, window, true);
				cursor = sliceByColumn(
					this.#value,
					this.#startColumn,
					Math.max(0, cursorColumn - this.#startColumn),
					true,
				).length;
			} else {
				text = "";
				cursor = 0;
			}
		}
		const character =
			getGraphemeSegmenter().segment(text.slice(cursor))[Symbol.iterator]().next().value?.segment ?? " ";
		const painted =
			text.slice(0, cursor) + marker + renderFakeCursor(character) + text.slice(cursor + character.length);
		return [this.#prompt + painted + " ".repeat(Math.max(0, available - visibleWidth(painted)))];
	}
}
