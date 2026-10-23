import { eastAsianWidth } from "get-east-asian-width";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const words = new Intl.Segmenter(undefined, { granularity: "word" });
export function getGraphemeSegmenter(): Intl.Segmenter {
	return graphemes;
}
export function getWordSegmenter(): Intl.Segmenter {
	return words;
}
export const PUNCTUATION_REGEX = /[(){}[\]<>.,;:'"!?+\-=*/\\|&%^$#@~`]/;
export const cjkBreakRegex =
	/[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}\p{Script_Extensions=Bopomofo}]/u;
export const cjkPunctuationRegex = new RegExp(
	`(?:(?=\\p{Punctuation})${cjkBreakRegex.source}|[，．：；！？（）［］｛｝“”‘’…—])`,
	"u",
);
export const autocompleteSeparatorRegex = new RegExp(`(?:\\s|${cjkPunctuationRegex.source})`, "u");
export const autocompleteBoundaryRegex = new RegExp(`(?:^|${autocompleteSeparatorRegex.source})`, "u");
export function isWhitespaceChar(text: string): boolean {
	return /\s/.test(text);
}
export function isPunctuationChar(text: string): boolean {
	return PUNCTUATION_REGEX.test(text);
}

const spacingMark =
	/^(?:[\p{Spacing_Mark}--[\u1734\u302E\u302F]]|[\u065F\u0F7F\u102B\u102C\u1031\u1033-\u1035\u1038\u103A-\u103E])+$/v;
const invisibleCluster = /^(?:\p{Default_Ignorable_Code_Point}|\p{Control}|\p{Mark}|\p{Surrogate})+$/v;
const leadingInvisible = /^[\p{Default_Ignorable_Code_Point}\p{Control}\p{Format}\p{Mark}\p{Surrogate}]+/v;
const invisible = /^(?:\p{Default_Ignorable_Code_Point}|\p{Control}|\p{Format}|\p{Mark}|\p{Surrogate})$/v;
const emoji = /^\p{RGI_Emoji}$/v;
function cellWidth(text: string): number {
	if (text === "\t") return 3;
	if (spacingMark.test(text)) return [...text].length;
	if (invisibleCluster.test(text)) return 0;
	if (emoji.test(text)) return 2;
	const base = [...text.replace(leadingInvisible, "")];
	const first = base[0]?.codePointAt(0);
	if (first === undefined) return 0;
	if (first >= 0x1f1e6 && first <= 0x1f1ff) return 2;
	let total = eastAsianWidth(first);
	let afterMark = false;
	for (const char of base.slice(1)) {
		if (spacingMark.test(char)) {
			total++;
			afterMark = false;
		} else if (/^\p{Mark}$/u.test(char)) afterMark = true;
		else if (!invisible.test(char)) {
			const code = char.codePointAt(0);
			if (code !== undefined) {
				if (afterMark || (code >= 0xff00 && code <= 0xffef)) total += eastAsianWidth(code);
				else if (code === 0xe33 || code === 0xeb3) total++;
			}
			afterMark = false;
		}
	}
	return total;
}

export function extractAnsiCode(text: string, offset: number): { code: string; length: number } | null {
	if (text[offset] !== "\x1b") return null;
	const introducer = text[offset + 1];
	for (let index = offset + 2; index < text.length; index++) {
		if (introducer === "[" && "mGKHJ".includes(text[index]))
			return { code: text.slice(offset, index + 1), length: index + 1 - offset };
		if (introducer === "]" || introducer === "_") {
			const end =
				text[index] === "\x07" ? index + 1 : text[index] === "\x1b" && text[index + 1] === "\\" ? index + 2 : 0;
			if (end) return { code: text.slice(offset, end), length: end - offset };
		}
	}
	return null;
}

type Unit = { kind: "ansi"; text: string } | { kind: "text"; text: string; width: number };
function* units(text: string): Generator<Unit> {
	let offset = 0;
	while (offset < text.length) {
		const control = extractAnsiCode(text, offset);
		if (control) {
			yield { kind: "ansi", text: control.code };
			offset += control.length;
			continue;
		}
		let end = offset + 1;
		while (end < text.length && !extractAnsiCode(text, end)) end++;
		for (const { segment } of graphemes.segment(text.slice(offset, end)))
			yield { kind: "text", text: segment, width: cellWidth(segment) };
		offset = end;
	}
}

export function stripTerminalSequences(text: string): string {
	let output = "";
	for (const unit of units(text)) if (unit.kind === "text") output += unit.text;
	return output;
}
const widthCache = new Map<string, number>();
export function visibleWidth(text: string): number {
	let asciiWidth = 0;
	for (let offset = 0; offset < text.length; offset++) {
		const code = text.charCodeAt(offset);
		if (code >= 32 && code <= 126) asciiWidth++;
		else if (code === 9) asciiWidth += 3;
		else {
			const control = code === 27 ? extractAnsiCode(text, offset) : null;
			if (!control) {
				asciiWidth = -1;
				break;
			}
			offset += control.length - 1;
		}
	}
	if (asciiWidth >= 0) return asciiWidth;
	const cached = widthCache.get(text);
	if (cached !== undefined) return cached;
	let width = 0;
	for (const { segment } of graphemes.segment(stripTerminalSequences(text).replace(/\t/g, "   ")))
		width += cellWidth(segment);
	if (widthCache.size >= 512) {
		const oldest = widthCache.keys().next().value;
		if (oldest !== undefined) widthCache.delete(oldest);
	}
	widthCache.set(text, width);
	return width;
}
export function getGraphemeCellRange(text: string, column: number): { start: number; end: number } | undefined {
	let position = 0;
	for (const unit of units(text))
		if (unit.kind === "text") {
			if (unit.width > 0 && column >= position && column < position + unit.width)
				return { start: position, end: position + unit.width };
			position += unit.width;
		}
	return undefined;
}
export function getOsc8LinkAtColumn(text: string, column: number): string | undefined {
	let position = 0;
	let link: string | undefined;
	for (const unit of units(text)) {
		if (unit.kind === "ansi") {
			const match = /^\x1b\]8;[^;]*;([^\x07\x1b]*)(?:\x07|\x1b\\)$/.exec(unit.text);
			if (match) link = match[1] || undefined;
		} else {
			if (column >= position && column < position + unit.width) return link;
			position += unit.width;
		}
	}
	return undefined;
}
export function normalizeTerminalOutput(text: string): string {
	const normalized = text.replace(/[\u0e33\u0eb3]/g, (char) => (char === "\u0e33" ? "\u0e4d\u0e32" : "\u0ecd\u0eb2"));
	let result = "";
	for (const unit of units(normalized)) result += unit.kind === "text" ? unit.text.replace(/\t/g, "   ") : unit.text;
	return result;
}

class StyleState {
	#attributes = new Set<number>();
	#foreground: string | undefined;
	#background: string | undefined;
	#link: { open: string; close: string } | undefined;
	process(control: string): void {
		const hyperlink = /^\x1b\]8;([^;]*);([^\x07\x1b]*)(\x07|\x1b\\)$/.exec(control);
		if (hyperlink) {
			this.#link = hyperlink[2] ? { open: control, close: `\x1b]8;;${hyperlink[3]}` } : undefined;
			return;
		}
		const sgr = control.endsWith("m") ? /\x1b\[([\d;]*)m/.exec(control) : null;
		if (!sgr) return;
		const codes = sgr[1] === "" ? ["0"] : sgr[1].split(";");
		for (let index = 0; index < codes.length; index++) {
			const code = Number.parseInt(codes[index], 10);
			if (code === 0) {
				this.#attributes.clear();
				this.#foreground = undefined;
				this.#background = undefined;
			} else if ([1, 2, 3, 4, 5, 7, 8, 9].includes(code)) this.#attributes.add(code);
			else if (code === 21) this.#attributes.delete(1);
			else if (code === 22) {
				this.#attributes.delete(1);
				this.#attributes.delete(2);
			} else if ([23, 24, 25, 27, 28, 29].includes(code)) this.#attributes.delete(code - 20);
			else if (code === 39) this.#foreground = undefined;
			else if (code === 49) this.#background = undefined;
			else if (code === 38 || code === 48) {
				const count = codes[index + 1] === "5" ? 3 : codes[index + 1] === "2" ? 5 : 0;
				if (count && codes[index + count - 1] !== undefined) {
					const color = codes.slice(index, index + count).join(";");
					if (code === 38) this.#foreground = color;
					else this.#background = color;
					index += count - 1;
				}
			} else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) this.#foreground = String(code);
			else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) this.#background = String(code);
		}
	}
	update(text: string): void {
		for (const unit of units(text)) if (unit.kind === "ansi") this.process(unit.text);
	}
	active(): string {
		const attributes = [...this.#attributes].sort((left, right) => left - right).map(String);
		if (this.#foreground) attributes.push(this.#foreground);
		if (this.#background) attributes.push(this.#background);
		return (attributes.length ? `\x1b[${attributes.join(";")}m` : "") + (this.#link?.open ?? "");
	}
	background(): string {
		return this.#background ? `\x1b[${this.#background}m` : "";
	}
	lineEnd(): string {
		return (this.#attributes.has(4) ? "\x1b[24m" : "") + this.closeLink();
	}
	closeLink(): string {
		return this.#link?.close ?? "";
	}
}

export function getActiveBackgroundAnsi(text: string): string {
	const style = new StyleState();
	style.update(text);
	return style.background();
}
export function flattenLines(lines: readonly string[]): void {
	for (const line of lines) Number(line);
}
export function applyBackgroundToLine(text: string, width: number, background: (text: string) => string): string {
	return background(text + " ".repeat(Math.max(0, width - visibleWidth(text))));
}

export function sliceWithWidth(
	text: string,
	startCol: number,
	length: number,
	strict = false,
): { text: string; width: number } {
	if (length <= 0) return { text: "", width: 0 };
	const end = startCol + length;
	let position = 0,
		output = "",
		pending = "",
		width = 0;
	for (const unit of units(text)) {
		if (unit.kind === "ansi") {
			if (position >= startCol && position < end) {
				output += pending + unit.text;
				pending = "";
			} else if (position < startCol) pending += unit.text;
		} else {
			if (position >= startCol && position < end && (!strict || position + unit.width <= end)) {
				output += pending + unit.text;
				pending = "";
				width += unit.width;
			}
			position += unit.width;
			if (position >= end) break;
		}
	}
	return { text: output, width };
}
export function sliceByColumn(text: string, startCol: number, length: number, strict = false): string {
	return sliceWithWidth(text, startCol, length, strict).text;
}

function prefix(text: string, width: number): { text: string; width: number } {
	let output = "",
		pending = "",
		used = 0;
	for (const unit of units(text)) {
		if (unit.kind === "ansi") {
			pending += unit.text;
			continue;
		}
		if (used + unit.width > width) break;
		output += pending + unit.text;
		pending = "";
		used += unit.width;
	}
	return { text: output, width: used };
}
export function truncateToWidth(text: string, maxWidth: number, ellipsis = "...", pad = false): string {
	if (maxWidth <= 0) return "";
	if (text.length === 0) return pad ? " ".repeat(maxWidth) : "";
	const ellipsisWidth = visibleWidth(ellipsis);
	let head = { text: "", width: 0 };
	let tail = { text: ellipsis, width: ellipsisWidth };
	if (ellipsisWidth >= maxWidth) {
		const width = visibleWidth(text);
		if (width <= maxWidth) return text + (pad ? " ".repeat(maxWidth - width) : "");
		tail = prefix(ellipsis, maxWidth);
		if (tail.width === 0) return pad ? " ".repeat(maxWidth) : "";
	} else if (/^[\x20-\x7e]*$/.test(text)) {
		if (text.length <= maxWidth) return text + (pad ? " ".repeat(maxWidth - text.length) : "");
		head = { text: text.slice(0, maxWidth - ellipsisWidth), width: maxWidth - ellipsisWidth };
	} else {
		const target = maxWidth - ellipsisWidth;
		let width = 0,
			pending = "",
			keeping = true;
		for (const unit of units(text)) {
			if (unit.kind === "ansi") {
				pending += unit.text;
				continue;
			}
			if (keeping && head.width + unit.width <= target) {
				head.text += pending + unit.text;
				head.width += unit.width;
			} else keeping = false;
			pending = "";
			width += unit.width;
			if (width > maxWidth) break;
		}
		if (width <= maxWidth) return text + (pad ? " ".repeat(Math.max(0, maxWidth - width)) : "");
	}
	const style = new StyleState();
	style.update(head.text);
	const output = head.text + style.closeLink() + "\x1b[0m" + tail.text + (tail.text ? "\x1b[0m" : "");
	return output + (pad ? " ".repeat(Math.max(0, maxWidth - head.width - tail.width)) : "");
}

export function extractSegments(
	text: string,
	beforeEnd: number,
	afterStart: number,
	afterLen: number,
	strictAfter = false,
): { before: string; beforeWidth: number; after: string; afterWidth: number } {
	let before = "",
		after = "",
		beforeWidth = 0,
		afterWidth = 0,
		position = 0,
		pending = "";
	let started = false;
	const style = new StyleState();
	for (const unit of units(text)) {
		if (unit.kind === "ansi") {
			style.process(unit.text);
			if (position < beforeEnd) pending += unit.text;
			else if (position >= afterStart && position < afterStart + afterLen && (started || unit.text.startsWith("\x1b_")))
				after += unit.text;
		} else {
			if (position < beforeEnd && position + unit.width <= beforeEnd) {
				before += pending + unit.text;
				pending = "";
				beforeWidth += unit.width;
			} else if (
				position >= afterStart &&
				position < afterStart + afterLen &&
				(!strictAfter || position + unit.width <= afterStart + afterLen)
			) {
				if (!started) {
					after += style.active();
					started = true;
				}
				after += unit.text;
				afterWidth += unit.width;
			}
			position += unit.width;
			if (position >= (afterLen <= 0 ? beforeEnd : afterStart + afterLen)) break;
		}
	}
	return { before, beforeWidth, after, afterWidth };
}

function tokens(text: string): string[] {
	const output: string[] = [];
	let current = "",
		pending = "",
		kind: "space" | "word" | undefined;
	const flush = (): void => {
		if (current) output.push(current);
		current = "";
		kind = undefined;
	};
	for (const unit of units(text)) {
		if (unit.kind === "ansi") {
			pending += unit.text;
			continue;
		}
		if (unit.text !== " " && cjkBreakRegex.test(unit.text)) {
			flush();
			output.push(pending + unit.text);
			pending = "";
			continue;
		}
		const next = unit.text === " " ? "space" : "word";
		if (kind !== next) flush();
		current += pending + unit.text;
		pending = "";
		kind = next;
	}
	if (pending) {
		if (current) current += pending;
		else if (output.length) output[output.length - 1] += pending;
		else current = pending;
	}
	flush();
	return output;
}
function breakToken(token: string, width: number, style: StyleState): string[] {
	const lines: string[] = [];
	let line = style.active(),
		used = 0;
	for (const unit of units(token)) {
		if (unit.kind === "ansi") {
			line += unit.text;
			style.process(unit.text);
			continue;
		}
		if (used + unit.width > width) {
			lines.push(line + style.lineEnd());
			line = style.active();
			used = 0;
		}
		line += unit.text;
		used += unit.width;
	}
	if (line) lines.push(line);
	return lines.length ? lines : [""];
}
function wrapLine(text: string, width: number): string[] {
	if (!text || visibleWidth(text) <= width) return [text];
	const style = new StyleState();
	const lines: string[] = [];
	let line = "",
		used = 0;
	for (const token of tokens(text)) {
		const size = visibleWidth(token),
			space = token.trim() === "";
		if (size > width && !space) {
			if (line) lines.push(line + style.lineEnd());
			const fragments = breakToken(token, width, style);
			lines.push(...fragments.slice(0, -1));
			line = fragments.at(-1) ?? "";
			used = visibleWidth(line);
			continue;
		}
		if (used + size > width && used > 0) {
			lines.push(line.trimEnd() + style.lineEnd());
			line = style.active() + (space ? "" : token);
			used = space ? 0 : size;
		} else {
			line += token;
			used += size;
		}
		style.update(token);
	}
	if (line) lines.push(line);
	return lines.length ? lines.map((value) => value.trimEnd()) : [""];
}
export function wrapTextWithAnsi(text: string, width: number): string[] {
	if (!text) return [""];
	const style = new StyleState();
	const output: string[] = [];
	for (const line of text.split(/\r\n|\r|\n/)) {
		output.push(...wrapLine((output.length ? style.active() : "") + line, width));
		style.update(line);
	}
	return output;
}
