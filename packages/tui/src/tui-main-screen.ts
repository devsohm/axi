import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { deleteKittyImage, isImageLine } from "./terminal-image.ts";
import { TuiBase, type TuiStopOptions } from "./tui.ts";
import { visibleWidth } from "./utils.ts";

export interface TuiMainScreenRenderState {
	previousLines: string[];
	previousWidth: number;
	previousHeight: number;
	cursorRow: number;
	hardwareCursorRow: number;
	maxLinesRendered: number;
	previousViewportTop: number;
}
class RenderWriter {
	#buffer = "";
	#count = 0;
	readonly #write: (text: string) => void;
	constructor(write: (text: string) => void) {
		this.#write = write;
	}
	append(text: string): void {
		let offset = 0;
		while (offset < text.length) {
			const capacity = 1024 * 1024 - this.#buffer.length;
			if (!capacity) {
				this.flush();
				continue;
			}
			let end = Math.min(text.length, offset + capacity);
			if (
				end < text.length &&
				text.charCodeAt(end - 1) >= 0xd800 &&
				text.charCodeAt(end - 1) <= 0xdbff &&
				text.charCodeAt(end) >= 0xdc00 &&
				text.charCodeAt(end) <= 0xdfff
			)
				end--;
			if (end === offset) {
				this.flush();
				continue;
			}
			this.#buffer += text.slice(offset, end);
			this.#count += end - offset;
			offset = end;
			if (this.#buffer.length === 1024 * 1024) this.flush();
		}
	}
	flush(): void {
		if (this.#buffer) {
			this.#write(this.#buffer);
			this.#buffer = "";
		}
	}
	get length(): number {
		return this.#count;
	}
}

function imageHeader(line: string): { ids: number[]; rows: number } | undefined {
	const start = line.indexOf("\x1b_G"),
		end = start < 0 ? -1 : line.indexOf(";", start + 3);
	if (end < 0) return undefined;
	const ids: number[] = [];
	let rows = 1;
	for (const control of line.slice(start + 3, end).split(",")) {
		const [key, text] = control.split("=", 2),
			value = Number(text);
		if (text === undefined || !Number.isInteger(value) || value <= 0 || value > 0xffffffff) continue;
		if (key === "i") ids.push(value);
		else if (key === "r") rows = value;
	}
	return { ids, rows };
}
function imageIds(lines: string[]): Set<number> {
	const ids = new Set<number>();
	for (const line of lines) for (const id of imageHeader(line)?.ids ?? []) ids.add(id);
	return ids;
}
function deleteImages(ids: Iterable<number>): string {
	let text = "";
	for (const id of ids) text += deleteKittyImage(id);
	return text;
}
function reservedRows(lines: string[], index: number, end = lines.length - 1): number {
	const requested = imageHeader(lines[index])?.rows ?? 1;
	const limit = Math.min(requested, end - index + 1, lines.length - index);
	let rows = 1;
	while (rows < limit && !isImageLine(lines[index + rows]) && visibleWidth(lines[index + rows]) === 0) rows++;
	return rows;
}
function emptyState(): TuiMainScreenRenderState {
	return {
		previousLines: [],
		previousWidth: 0,
		previousHeight: 0,
		cursorRow: 0,
		hardwareCursorRow: 0,
		maxLinesRendered: 0,
		previousViewportTop: 0,
	};
}

export class TuiMainScreen extends TuiBase {
	readonly mode = "regular";
	#state = emptyState();
	#images = new Set<number>();
	captureRenderState(): TuiMainScreenRenderState {
		return { ...this.#state, previousLines: [...this.#state.previousLines] };
	}
	restoreRenderState(state: TuiMainScreenRenderState): void {
		this.#state = { ...state, previousLines: state.previousLines.map((line) => (isImageLine(line) ? "" : line)) };
		this.#images = new Set();
	}
	protected override resetRenderState(): void {
		this.#state = { ...emptyState(), previousWidth: -1, previousHeight: -1 };
	}
	protected override beforeTerminalStop(options: TuiStopOptions): void {
		if (options.preserveScreen || !this.#state.previousLines.length) return;
		this.terminal.write(" ");
		const delta = this.#state.previousLines.length - this.#state.hardwareCursorRow;
		if (delta) this.terminal.write(`\x1b[${Math.abs(delta)}${delta > 0 ? "B" : "A"}`);
		this.terminal.write("\r\n");
	}
	#position(cursor: { row: number; col: number } | null, total: number): void {
		if (!cursor || total <= 0) {
			this.terminal.hideCursor();
			return;
		}
		const row = Math.max(0, Math.min(cursor.row, total - 1)),
			delta = row - this.#state.hardwareCursorRow;
		this.terminal.write(
			(delta ? `\x1b[${Math.abs(delta)}${delta > 0 ? "B" : "A"}` : "") + `\x1b[${Math.max(0, cursor.col) + 1}G`,
		);
		this.#state.hardwareCursorRow = row;
		if (this.getShowHardwareCursor()) this.terminal.showCursor();
		else this.terminal.hideCursor();
	}
	protected doRender(): void {
		if (this.stopped) return;
		const state = this.#state,
			width = this.terminal.columns,
			height = this.terminal.rows;
		const widthChanged = state.previousWidth !== 0 && state.previousWidth !== width,
			heightChanged = state.previousHeight !== 0 && state.previousHeight !== height;
		let previousTop = heightChanged
			? Math.max(0, (state.previousHeight > 0 ? state.previousViewportTop + state.previousHeight : height) - height)
			: state.previousViewportTop;
		let viewportTop = previousTop,
			hardwareRow = state.hardwareCursorRow;
		let lines = this.resolveFakeCursors(this.render(width));
		if (this.hasOverlayEntries) lines = this.compositeOverlays(lines, width, height);
		const cursor = this.extractCursorPosition(lines, height);
		lines = this.applyLineResets(lines);
		const writer = (): RenderWriter => new RenderWriter((text) => this.terminal.write(text));
		const lineDelta = (target: number): number => target - viewportTop - (hardwareRow - previousTop);
		const move = (output: RenderWriter, delta: number): void => {
			if (delta) output.append(`\x1b[${Math.abs(delta)}${delta > 0 ? "B" : "A"}`);
		};
		const commitLines = (): void => {
			state.previousLines = lines;
			state.previousWidth = width;
			state.previousHeight = height;
			this.#images = imageIds(lines);
		};
		const full = (clear: boolean, reason: string): void => {
			if (process.env.AXI_TUI_DEBUG_REDRAW === "1" && this.logDirectory !== undefined) {
				mkdirSync(this.logDirectory, { recursive: true });
				appendFileSync(
					join(this.logDirectory, "axi-tui-debug.log"),
					`[${new Date().toISOString()}] fullRender: ${reason} (prev=${state.previousLines.length}, new=${lines.length}, height=${height})\n`,
				);
			}
			this.fullRedrawCount++;
			const output = writer();
			output.append("\x1b[?2026h");
			if (clear) output.append(deleteImages(this.#images) + "\x1b[2J\x1b[H\x1b[3J");
			for (let index = 0; index < lines.length; index++) {
				if (index) output.append("\r\n");
				const rows = isImageLine(lines[index]) ? reservedRows(lines, index) : 1;
				if (rows > 1 && rows <= height) {
					output.append("\r\n".repeat(rows - 1) + `\x1b[${rows - 1}A` + lines[index] + `\x1b[${rows - 1}B`);
					index += rows - 1;
				} else output.append(lines[index]);
			}
			output.append("\x1b[?2026l");
			output.flush();
			state.cursorRow = Math.max(0, lines.length - 1);
			state.hardwareCursorRow = state.cursorRow;
			state.maxLinesRendered = clear ? lines.length : Math.max(state.maxLinesRendered, lines.length);
			state.previousViewportTop = Math.max(0, Math.max(height, lines.length) - height);
			this.#position(cursor, lines.length);
			commitLines();
		};
		if (
			(!state.previousLines.length && !widthChanged && !heightChanged) ||
			widthChanged ||
			(heightChanged && !process.env.TERMUX_VERSION) ||
			(this.getClearOnShrink() && lines.length < state.maxLinesRendered && !this.hasOverlayEntries)
		) {
			full(
				Boolean(widthChanged || heightChanged || state.previousLines.length),
				!state.previousLines.length && !widthChanged && !heightChanged
					? "first render"
					: widthChanged
						? `terminal width changed (${state.previousWidth} -> ${width})`
						: heightChanged
							? `terminal height changed (${state.previousHeight} -> ${height})`
							: `clearOnShrink (maxLinesRendered=${state.maxLinesRendered})`,
			);
			return;
		}
		let first = -1,
			last = -1;
		for (let index = 0; index < Math.max(lines.length, state.previousLines.length); index++)
			if ((lines[index] ?? "") !== (state.previousLines[index] ?? "")) {
				if (first < 0) first = index;
				last = index;
			}
		const appended = lines.length > state.previousLines.length;
		if (appended) {
			if (first < 0) first = state.previousLines.length;
			last = lines.length - 1;
		}
		if (first >= 0) {
			const originalFirst = first,
				originalLast = last;
			for (const values of [state.previousLines, lines])
				for (let index = 0; index < values.length; index++) {
					if (!imageHeader(values[index])?.ids.length) continue;
					const end = index + reservedRows(values, index) - 1;
					if (index >= originalFirst || (index <= originalLast && end >= originalFirst)) {
						first = Math.min(first, index);
						last = Math.max(last, end);
					}
				}
		}
		if (first < 0) {
			this.#position(cursor, lines.length);
			state.previousViewportTop = previousTop;
			state.previousHeight = height;
			return;
		}
		const changedImages = (): string =>
			deleteImages(imageIds(state.previousLines.slice(first, Math.min(last + 1, state.previousLines.length))));
		if (first >= lines.length) {
			if (state.previousLines.length > lines.length) {
				const target = Math.max(0, lines.length - 1),
					extra = state.previousLines.length - lines.length;
				if (target < previousTop || extra > height) {
					full(
						true,
						target < previousTop
							? `deleted lines moved viewport up (${target} < ${previousTop})`
							: `extraLines > height (${extra} > ${height})`,
					);
					return;
				}
				const output = writer();
				output.append("\x1b[?2026h" + changedImages());
				move(output, lineDelta(target));
				output.append("\r");
				const offset = lines.length ? 1 : 0;
				if (extra > 0 && offset) output.append(`\x1b[${offset}B`);
				for (let index = 0; index < extra; index++) {
					output.append("\r\x1b[2K");
					if (index < extra - 1) output.append("\x1b[1B");
				}
				move(output, -Math.max(0, extra - 1 + offset));
				output.append("\x1b[?2026l");
				output.flush();
				state.cursorRow = target;
				state.hardwareCursorRow = target;
			}
			this.#position(cursor, lines.length);
			commitLines();
			state.previousViewportTop = previousTop;
			return;
		}
		if (first < previousTop) {
			full(true, `firstChanged < viewportTop (${first} < ${previousTop})`);
			return;
		}
		const output = writer();
		output.append("\x1b[?2026h" + changedImages());
		const appendStart = appended && first === state.previousLines.length && first > 0,
			target = appendStart ? first - 1 : first;
		const bottom = previousTop + height - 1;
		if (target > bottom) {
			const screenRow = Math.max(0, Math.min(height - 1, hardwareRow - previousTop));
			move(output, height - 1 - screenRow);
			const scroll = target - bottom;
			output.append("\r\n".repeat(scroll));
			previousTop += scroll;
			viewportTop += scroll;
			hardwareRow = target;
		}
		move(output, lineDelta(target));
		output.append(appendStart ? "\r\n" : "\r");
		const renderEnd = Math.min(last, lines.length - 1);
		for (let index = first; index <= renderEnd; index++) {
			if (index > first) output.append("\r\n");
			const image = isImageLine(lines[index]),
				rows = image ? reservedRows(lines, index, renderEnd) : 1;
			if (rows > 1) {
				if (index - viewportTop < 0 || index - viewportTop + rows > height) {
					full(true, `kitty image pre-clear would scroll (${index - viewportTop} + ${rows} > ${height})`);
					return;
				}
				output.append(
					"\x1b[2K" + "\r\n\x1b[2K".repeat(rows - 1) + `\x1b[${rows - 1}A` + lines[index] + `\x1b[${rows - 1}B`,
				);
				index += rows - 1;
				continue;
			}
			output.append("\x1b[2K");
			if (!image && visibleWidth(lines[index]) > width) {
				const path = join(this.logDirectory ?? tmpdir(), "axi-tui-crash.log");
				mkdirSync(dirname(path), { recursive: true });
				writeFileSync(
					path,
					[
						`Crash at ${new Date().toISOString()}`,
						`Terminal width: ${width}`,
						`Line ${index} visible width: ${visibleWidth(lines[index])}`,
						"",
						"=== All rendered lines ===",
						...lines.map((line, row) => `[${row}] (w=${visibleWidth(line)}) ${line}`),
						"",
					].join("\n"),
				);
				this.stop();
				throw new Error(
					[
						`Rendered line ${index} exceeds terminal width (${visibleWidth(lines[index])} > ${width}).`,
						"",
						"This is likely caused by a custom TUI component not truncating its output.",
						"Use visibleWidth() to measure and truncateToWidth() to truncate lines.",
						"",
						`Debug log written to: ${path}`,
					].join("\n"),
				);
			}
			output.append(lines[index]);
		}
		let finalRow = renderEnd;
		if (state.previousLines.length > lines.length) {
			if (renderEnd < lines.length - 1) {
				move(output, lines.length - 1 - renderEnd);
				finalRow = lines.length - 1;
			}
			const extra = state.previousLines.length - lines.length;
			output.append("\r\n\x1b[2K".repeat(extra));
			move(output, -extra);
		}
		output.append("\x1b[?2026l");
		if (process.env.AXI_TUI_DEBUG === "1") {
			const directory = "/tmp/tui";
			mkdirSync(directory, { recursive: true });
			writeFileSync(
				join(directory, `render-${Date.now()}-${Math.random().toString(36).slice(2)}.log`),
				[
					`firstChanged: ${first}`,
					`viewportTop: ${viewportTop}`,
					`cursorRow: ${state.cursorRow}`,
					`height: ${height}`,
					`lineDiff: ${lineDelta(target)}`,
					`hardwareCursorRow: ${hardwareRow}`,
					`renderEnd: ${renderEnd}`,
					`finalCursorRow: ${finalRow}`,
					`cursorPos: ${JSON.stringify(cursor)}`,
					`newLines.length: ${lines.length}`,
					`previousLines.length: ${state.previousLines.length}`,
					"",
					"=== newLines ===",
					JSON.stringify(lines, null, 2),
					"",
					"=== previousLines ===",
					JSON.stringify(state.previousLines, null, 2),
					"",
					"=== buffer ===",
					`[${output.length} chars written in bounded chunks]`,
				].join("\n"),
			);
		}
		output.flush();
		state.cursorRow = Math.max(0, lines.length - 1);
		state.hardwareCursorRow = finalRow;
		state.maxLinesRendered = Math.max(state.maxLinesRendered, lines.length);
		state.previousViewportTop = Math.max(previousTop, finalRow - height + 1);
		this.#position(cursor, lines.length);
		commitLines();
	}
}
