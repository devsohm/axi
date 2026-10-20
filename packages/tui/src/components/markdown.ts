import { Marked, Tokenizer, type Token, type Tokens, type TokenizerExtension } from "marked";
import markedCjkFriendly from "marked-cjk-friendly";
import { renderLatex } from "../latex.ts";
import { getCapabilities, hyperlink, isImageLine } from "../terminal-image.ts";
import type { Component } from "../tui.ts";
import { applyBackgroundToLine, flattenLines, visibleWidth, wrapTextWithAnsi } from "../utils.ts";
class StrictTokenizer extends Tokenizer {
	override del(source: string): Tokens.Del | undefined {
		const match = /^(~~)(?=[^\s~])((?:\\.|[^\\])*?(?:\\.|[^\s~\\]))\1(?=[^~]|$)/.exec(source);
		return match
			? { type: "del", raw: match[0], text: match[2]!, tokens: this.lexer.inlineTokens(match[2]!) }
			: undefined;
	}
}
interface MathToken extends Tokens.Generic {
	type: "latex" | "latexBlock";
	text: string;
	pending?: boolean;
}
function escaped(source: string, index: number): boolean {
	let count = 0;
	while (index > 0 && source[--index] === "\\") count++;
	return count % 2 === 1;
}
function closer(source: string, value: string, start: number): number {
	let index = source.indexOf(value, start);
	while (index >= 0 && escaped(source, index)) index = source.indexOf(value, index + value.length);
	return index;
}
function pendingMath(value: string): boolean {
	return /\\[A-Za-z]+|[_^=+*/<>()[\]|±≤≥≠≈∈→⇒∞∫∑√-]/.test(value);
}
function inlineMath(source: string): MathToken | undefined {
	let open: string, close: string;
	if (source.startsWith("$$")) {
		open = "$$";
		close = "$$";
	} else if (source.startsWith("\\(")) {
		open = "\\(";
		close = "\\)";
	} else if (source.startsWith("\\[")) {
		open = "\\[";
		close = "\\]";
	} else if (source.startsWith("$") && !/^\$\s/.test(source)) {
		open = "$";
		close = "$";
	} else return;
	const end = closer(source, close, open.length),
		value = source.slice(open.length, end < 0 ? undefined : end);
	if (
		end >= 0 &&
		open === "$" &&
		(/\s$/.test(value) ||
			/^\d/.test(source.slice(end + 1)) ||
			(/^[A-Z_][A-Z0-9_]*(?:[^A-Za-z0-9_\s])?$/.test(value) && /^[A-Za-z_][A-Za-z0-9_]*/.test(source.slice(end + 1))) ||
			value.includes("`"))
	)
		return;
	if (end < 0)
		return open.startsWith("\\") || pendingMath(value)
			? { type: "latex", raw: source, text: value, pending: true }
			: undefined;
	if (!value || value.includes("\n")) return;
	return { type: "latex", raw: source.slice(0, end + close.length), text: value };
}
function blockMath(source: string): MathToken | undefined {
	for (const pattern of [
		/^ {0,3}\$\$[ \t]*(?:\n)?([\s\S]*?)\$\$[ \t]*(?:\n|$)/,
		/^ {0,3}\\\[[ \t]*(?:\n)?([\s\S]*?)\\\][ \t]*(?:\n|$)/,
	]) {
		const match = pattern.exec(source);
		if (match?.[1]) return { type: "latexBlock", raw: match[0], text: match[1].trim() };
	}
	const bracket = /^ {0,3}\\\[[ \t]*(?:\n)?([\s\S]*)$/.exec(source);
	if (bracket) return { type: "latexBlock", raw: bracket[0], text: bracket[1]!, pending: true };
	const dollar = /^ {0,3}\$\$[ \t]*(?:\n)?([\s\S]*)$/.exec(source);
	if (dollar?.[1] && pendingMath(dollar[1]))
		return { type: "latexBlock", raw: dollar[0], text: dollar[1], pending: true };
	return;
}
const extensions: TokenizerExtension[] = [
	{
		name: "latexBlock",
		level: "block",
		start(source) {
			const match = /(?:^|\n) {0,3}(?:\$\$|\\\[)/.exec(source);
			return match ? match.index + (match[0].startsWith("\n") ? 1 : 0) : undefined;
		},
		tokenizer: blockMath,
	},
	{
		name: "latex",
		level: "inline",
		start(source) {
			const indices = [source.indexOf("$"), source.indexOf("\\("), source.indexOf("\\[")].filter((index) => index >= 0);
			return indices.length ? Math.min(...indices) : undefined;
		},
		tokenizer: inlineMath,
	},
];
const parser = new Marked();
parser.setOptions({ tokenizer: new StrictTokenizer() });
parser.use({ tokenizer: { emStrong: markedCjkFriendly().tokenizer?.emStrong }, extensions });
function trimFences(tokens: readonly Token[]): void {
	const last = tokens.at(-1);
	if (last?.type === "list") {
		trimFences(last.items.at(-1)?.tokens ?? []);
		return;
	}
	if (last?.type === "blockquote") {
		trimFences(last.tokens ?? []);
		return;
	}
	if (last?.type !== "code") return;
	const marker = /^(`{3,}|~{3,})/.exec(last.raw)?.[1],
		tail = last.raw.split("\n").at(-1);
	if (marker && tail && tail.length < marker.length && tail === marker[0]!.repeat(tail.length))
		last.text = last.text.slice(0, -tail.length).replace(/\n$/, "");
}
export interface DefaultTextStyle {
	color?: (text: string) => string;
	bgColor?: (text: string) => string;
	bold?: boolean;
	italic?: boolean;
	strikethrough?: boolean;
	underline?: boolean;
}
export interface MarkdownTheme {
	heading: (text: string) => string;
	link: (text: string) => string;
	linkUrl: (text: string) => string;
	code: (text: string) => string;
	codeBlock: (text: string) => string;
	codeBlockBorder: (text: string) => string;
	quote: (text: string) => string;
	quoteBorder: (text: string) => string;
	hr: (text: string) => string;
	listBullet: (text: string) => string;
	bold: (text: string) => string;
	italic: (text: string) => string;
	strikethrough: (text: string) => string;
	underline: (text: string) => string;
	highlightCode?: (code: string, lang?: string) => string[];
	codeBlockIndent?: string;
}
export interface MarkdownOptions {
	preserveOrderedListMarkers?: boolean;
	preserveBackslashEscapes?: boolean;
	transform?: (markdown: string, availableWidth: number) => string;
	renderLatex?: boolean;
}
type Style = { applyText: (text: string) => string; stylePrefix: string };
function prefix(style: (text: string) => string): string {
	const value = style("\0"),
		index = value.indexOf("\0");
	return index < 0 ? "" : value.slice(0, index);
}
export class Markdown implements Component {
	#text: string;
	readonly #paddingX: number;
	readonly #paddingY: number;
	readonly #theme: MarkdownTheme;
	readonly #default: DefaultTextStyle | undefined;
	readonly #options: MarkdownOptions;
	#prefix: string | undefined;
	#cache: { text: string; width: number; lines: string[] } | undefined;
	#tokens: WeakRef<{ source: string; tokens: Token[] }> | undefined;
	constructor(
		text: string,
		paddingX: number,
		paddingY: number,
		theme: MarkdownTheme,
		defaultTextStyle?: DefaultTextStyle,
		options?: MarkdownOptions,
	) {
		this.#text = text;
		this.#paddingX = paddingX;
		this.#paddingY = paddingY;
		this.#theme = theme;
		this.#default = defaultTextStyle;
		this.#options = { ...options };
	}
	setText(text: string): void {
		this.#text = text;
		this.invalidate();
	}
	invalidate(): void {
		this.#cache = undefined;
	}
	private defaultStyle(text: string): string {
		let result = this.#default?.color?.(text) ?? text;
		for (const key of ["bold", "italic", "strikethrough", "underline"] as const)
			if (this.#default?.[key]) result = this.#theme[key](result);
		return result;
	}
	private context(): Style {
		if (this.#prefix === undefined) this.#prefix = this.#default ? prefix((text) => this.defaultStyle(text)) : "";
		return { applyText: (text) => this.defaultStyle(text), stylePrefix: this.#prefix };
	}
	render(width: number): string[] {
		if (this.#cache?.text === this.#text && this.#cache.width === width) return this.#cache.lines;
		const contentWidth = Math.max(1, width - this.#paddingX * 2),
			text = this.#options.transform?.(this.#text, contentWidth) ?? this.#text;
		if (!text.trim()) {
			const lines: string[] = [];
			this.#cache = { text: this.#text, width, lines };
			return lines;
		}
		const source = text.replace(/\t/g, "   "),
			cached = this.#tokens?.deref();
		let tokens = cached?.source === source ? cached.tokens : undefined;
		if (!tokens) {
			tokens = parser.lexer(source);
			trimFences(tokens);
			this.#tokens = new WeakRef({ source, tokens });
		}
		const rendered = tokens.flatMap((token, index) => this.block(token, contentWidth, tokens[index + 1]?.type));
		const lines = rendered.flatMap((line) => (isImageLine(line) ? [line] : wrapTextWithAnsi(line, contentWidth)));
		const margin = " ".repeat(this.#paddingX),
			bg = this.#default?.bgColor;
		const content = lines.map((line) => {
			if (isImageLine(line)) return line;
			const value = margin + line + margin;
			return bg
				? applyBackgroundToLine(value, width, bg)
				: value + " ".repeat(Math.max(0, width - visibleWidth(value)));
		});
		const empty = " ".repeat(width),
			padding = Array.from({ length: Math.ceil(this.#paddingY) }, () =>
				bg ? applyBackgroundToLine(empty, width, bg) : empty,
			),
			result = [...padding, ...content, ...padding];
		flattenLines(result);
		this.#cache = { text: this.#text, width, lines: result };
		return result.length ? result : [""];
	}
	private inline(tokens: Token[], context = this.context()): string {
		let result = "";
		const apply = (text: string) => text.split("\n").map(context.applyText).join("\n"),
			theme = this.#theme;
		for (const token of tokens) {
			switch (token.type) {
				case "latex": {
					const math = token as MathToken;
					result += apply(
						!math.pending && this.#options.renderLatex !== false ? (renderLatex(math.text) ?? math.raw) : math.raw,
					);
					break;
				}
				case "escape":
					result += apply(this.#options.preserveBackslashEscapes ? token.raw : token.text);
					break;
				case "text":
					result += token.tokens?.length ? this.inline(token.tokens, context) : apply(token.text);
					break;
				case "paragraph":
					result += this.inline(token.tokens ?? [], context);
					break;
				case "strong":
					result += theme.bold(this.inline(token.tokens ?? [], context)) + context.stylePrefix;
					break;
				case "em":
					result += theme.italic(this.inline(token.tokens ?? [], context)) + context.stylePrefix;
					break;
				case "del":
					result += theme.strikethrough(this.inline(token.tokens ?? [], context)) + context.stylePrefix;
					break;
				case "codespan":
					result += theme.code(token.text) + context.stylePrefix;
					break;
				case "link": {
					const text = this.inline(token.tokens ?? [], context),
						styled = theme.link(theme.underline(text));
					if (getCapabilities().hyperlinks) result += hyperlink(styled, token.href) + context.stylePrefix;
					else {
						const comparison = token.href.startsWith("mailto:") ? token.href.slice(7) : token.href;
						result +=
							styled +
							(token.text === token.href || token.text === comparison ? "" : theme.linkUrl(` (${token.href})`)) +
							context.stylePrefix;
					}
					break;
				}
				case "br":
					result += "\n";
					break;
				case "html":
					if (typeof token.raw === "string") result += apply(token.raw);
					break;
				default:
					if ("text" in token && typeof token.text === "string") result += apply(token.text);
			}
		}
		while (context.stylePrefix && result.endsWith(context.stylePrefix))
			result = result.slice(0, -context.stylePrefix.length);
		return result;
	}
	private block(token: Token, width: number, next?: string, context?: Style): string[] {
		const theme = this.#theme,
			space = next && next !== "space" ? [""] : [];
		switch (token.type) {
			case "heading": {
				const style = (text: string) => theme.heading(theme.bold(token.depth === 1 ? theme.underline(text) : text)),
					ctx = { applyText: style, stylePrefix: prefix(style) };
				return [
					(token.depth >= 3 ? style("#".repeat(token.depth) + " ") : "") + this.inline(token.tokens ?? [], ctx),
					...space,
				];
			}
			case "paragraph":
				return [this.inline(token.tokens ?? [], context), ...(next && next !== "list" && next !== "space" ? [""] : [])];
			case "text":
				return [this.inline([token], context)];
			case "latexBlock": {
				const math = token as MathToken,
					value =
						!math.pending && this.#options.renderLatex !== false
							? (renderLatex(math.text, { display: true }) ?? math.raw.trim())
							: math.raw.trim();
				return [...value.split("\n").map((line) => this.defaultStyle(line)), ...space];
			}
			case "code": {
				const indent = theme.codeBlockIndent ?? "  ",
					body =
						theme.highlightCode?.(token.text, token.lang) ??
						token.text.split("\n").map((line: string) => theme.codeBlock(line));
				return [
					theme.codeBlockBorder("```" + (token.lang ?? "")),
					...body.map((line: string) => indent + line),
					theme.codeBlockBorder("```"),
					...space,
				];
			}
			case "list":
				return this.list(token as Tokens.List, 0, width, context);
			case "table":
				return this.table(token as Tokens.Table, width, next, context);
			case "blockquote": {
				const style = (text: string) => theme.quote(theme.italic(text)),
					start = prefix(style),
					ctx = { applyText: (text: string) => text, stylePrefix: start },
					innerWidth = Math.max(1, width - 2),
					tokens: Token[] = token.tokens ?? [];
				const lines = tokens.flatMap((child, index) => this.block(child, innerWidth, tokens[index + 1]?.type, ctx));
				while (lines.at(-1) === "") lines.pop();
				return [
					...lines.flatMap((line) =>
						wrapTextWithAnsi(style(start ? line.replace(/\x1b\[0m/g, "\x1b[0m" + start) : line), innerWidth).map(
							(row) => theme.quoteBorder("│ ") + row,
						),
					),
					...space,
				];
			}
			case "hr":
				return [theme.hr("─".repeat(Math.min(width, 80))), ...space];
			case "html":
				return typeof token.raw === "string" ? [this.defaultStyle(token.raw.trim())] : [];
			case "space":
				return [""];
			default:
				return "text" in token && typeof token.text === "string" ? [token.text] : [];
		}
	}
	private list(token: Tokens.List, depth: number, width: number, context?: Style): string[] {
		const lines: string[] = [],
			indent = "    ".repeat(depth),
			start = typeof token.start === "number" ? token.start : 1;
		for (const [index, item] of token.items.entries()) {
			const fallback = token.ordered ? `${start + index}. ` : "- ";
			const match = this.#options.preserveOrderedListMarkers
				? token.ordered
					? /^ {0,3}(\d{1,9}[.)])[ \t]+/.exec(item.raw)
					: /^ {0,3}([-+*])(?:[ \t]+|(?=\r?\n|$))/.exec(item.raw)
				: undefined;
			const bullet = match ? match[1] + " " : fallback,
				marker = bullet + (item.task ? `[${item.checked ? "x" : " "}] ` : ""),
				first = indent + this.#theme.listBullet(marker),
				rest = indent + " ".repeat(visibleWidth(marker)),
				innerWidth = Math.max(1, width - visibleWidth(first));
			let any = false;
			for (const child of item.tokens) {
				if (child.type === "list") {
					lines.push(...this.list(child as Tokens.List, depth + 1, width, context));
					any = true;
					continue;
				}
				for (const line of this.block(child, innerWidth, undefined, context))
					for (const wrapped of wrapTextWithAnsi(line, innerWidth)) {
						lines.push((any ? rest : first) + wrapped);
						any = true;
					}
			}
			if (!any) lines.push(first);
			if (token.loose && index < token.items.length - 1) lines.push("");
		}
		return lines;
	}
	private table(token: Tokens.Table, width: number, next?: string, context?: Style): string[] {
		const count = token.header.length;
		if (!count) return [];
		const available = width - (3 * count + 1),
			space = next && next !== "space" ? [""] : [];
		if (available < count) return [...(token.raw ? wrapTextWithAnsi(token.raw, width) : []), ...space];
		const natural = Array<number>(count).fill(0),
			words = Array<number>(count).fill(1);
		for (const row of [token.header, ...token.rows])
			for (const [index, cell] of row.entries()) {
				const value = this.inline(cell.tokens ?? [], context);
				natural[index] = Math.max(natural[index] ?? 0, visibleWidth(value));
				const longest = value
					.split(/\s+/)
					.filter(Boolean)
					.reduce((max, word) => Math.max(max, visibleWidth(word)), 0);
				words[index] = Math.max(words[index] ?? 1, Math.min(longest, 30));
			}
		let minimum = words;
		if (minimum.reduce((a, b) => a + b, 0) > available) {
			const remaining = available - count,
				total = words.reduce((sum, value) => sum + Math.max(0, value - 1), 0),
				growth = words.map((value) => (total > 0 ? Math.floor((Math.max(0, value - 1) / total) * remaining) : 0));
			minimum = growth.map((value) => value + 1);
			let leftover = remaining - growth.reduce((a, b) => a + b, 0);
			for (let index = 0; leftover > 0 && index < count; index++, leftover--) minimum[index]++;
		}
		let widths: number[];
		if (natural.reduce((a, b) => a + b, 0) + 3 * count + 1 <= width)
			widths = natural.map((value, index) => Math.max(value, minimum[index]!));
		else {
			const total = natural.reduce((sum, value, index) => sum + Math.max(0, value - minimum[index]!), 0),
				extra = Math.max(0, available - minimum.reduce((a, b) => a + b, 0));
			widths = minimum.map(
				(value, index) => value + (total > 0 ? Math.floor((Math.max(0, natural[index]! - value) / total) * extra) : 0),
			);
			let remaining = available - widths.reduce((a, b) => a + b, 0);
			while (remaining > 0) {
				let grew = false;
				for (let index = 0; index < count && remaining > 0; index++)
					if (widths[index]! < natural[index]!) {
						widths[index]++;
						remaining--;
						grew = true;
					}
				if (!grew) break;
			}
		}
		const border = (left: string, middle: string, right: string) =>
			left + widths.map((value) => "─".repeat(value)).join(middle) + right;
		const separator = border("├─", "─┼─", "─┤"),
			lines = [border("┌─", "─┬─", "─┐")];
		const renderRow = (row: Tokens.TableCell[], header: boolean) => {
			const cells = row.map((cell, index) => {
				const wrapped = wrapTextWithAnsi(this.inline(cell.tokens ?? [], context), Math.max(1, widths[index]!));
				return wrapped.map(
					(line, index) =>
						line + (index < wrapped.length - 1 ? "\x1b[22;23;24;25;27;28;29;39m" : "") + (context?.stylePrefix ?? ""),
				);
			});
			const height = Math.max(...cells.map((cell) => cell.length));
			for (let index = 0; index < height; index++) {
				const values = cells.map((cell, column) => {
					const value = cell[index] ?? "",
						padded = value + " ".repeat(Math.max(0, widths[column]! - visibleWidth(value)));
					return header ? this.#theme.bold(padded) : padded;
				});
				lines.push("│ " + values.join(" │ ") + " │");
			}
		};
		renderRow(token.header, true);
		lines.push(separator);
		for (const [index, row] of token.rows.entries()) {
			renderRow(row, false);
			if (index < token.rows.length - 1) lines.push(separator);
		}
		lines.push(border("└─", "─┴─", "─┘"), ...space);
		return lines;
	}
}
