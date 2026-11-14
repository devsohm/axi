import { afterEach, expect, test, vi } from "vitest";
import { Markdown, type MarkdownTheme } from "../src/components/markdown.ts";
import { Text } from "../src/components/text.ts";
import { renderLatex } from "../src/latex.ts";
import {
	backgroundAnsi,
	colorToHex,
	foregroundAnsi,
	indexedColor,
	mixColors,
	okhslColor,
	oklchColor,
	parseColor,
	rgbColor,
	styleText,
} from "../src/colors.ts";
import { Image, setImageTranscoder } from "../src/components/image.ts";
import { getImageDimensions, resetCapabilitiesCache, setCapabilities } from "../src/terminal-image.ts";
import {
	extractSegments,
	getGraphemeSegmenter,
	normalizeTerminalOutput,
	stripTerminalSequences,
	visibleWidth,
	sliceByColumn,
	truncateToWidth,
	wrapTextWithAnsi,
} from "../src/utils.ts";
const plain = (text: string) => text;
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4c8AAAAASUVORK5CYII=";
const theme: MarkdownTheme = {
	heading: plain,
	link: plain,
	linkUrl: plain,
	code: plain,
	codeBlock: plain,
	codeBlockBorder: plain,
	quote: plain,
	quoteBorder: plain,
	hr: plain,
	listBullet: plain,
	bold: plain,
	italic: plain,
	strikethrough: plain,
	underline: plain,
};

test("wrapping large tokens and word sequences preserves every output line", () => {
	const length = 150_000;
	for (const source of ["x".repeat(length), "x ".repeat(length)]) {
		const lines = wrapTextWithAnsi(source, 1);
		expect(lines).toHaveLength(length);
		expect(lines.join("")).toBe("x".repeat(length));
	}
});

test("HTML comments disappear from blocks and inline text but remain literal in code", () => {
	const render = (source: string) => new Markdown(source, 0, 0, theme).render(60).map((line) => line.trimEnd());
	expect(render("before\n\n<!-- hidden -->\n\nafter")).toEqual(["before", "", "after"]);
	expect(render("a <!-- hidden --> b")).toEqual(["a b"]);
	expect(render("<!-- still streaming")).toEqual([""]);
	expect(render("`<!-- visible -->`")).toEqual(["<!-- visible -->"]);
	expect(render("> <!-- hidden -->\n>\n> visible")).toEqual(["│ visible"]);
});

test("a list followed by an HTML block keeps each block at its own indentation", () => {
	expect(new Markdown("- a\n<b>", 0, 0, theme).render(20).map((line) => line.trimEnd())).toEqual(["- a", "<b>"]);
});

test("unassigned code points keep their configured terminal-cell width", () => {
	const text = "\u{18cd6}";
	expect(visibleWidth(text)).toBe(1);
	expect(wrapTextWithAnsi(text + "X", 2)).toEqual([text + "X"]);
});

test("setting unchanged text retains the previous wrapped output", () => {
	const text = new Text("one two", 0, 0);
	const rendered = text.render(4);
	text.setText("one two");
	expect(text.render(4)).toBe(rendered);
	text.setText("three");
	expect(text.render(4)).not.toEqual(rendered);
});

test("streaming and resizing reuse code highlighting until the theme is invalidated", () => {
	const calls: string[] = [];
	const markdown = new Markdown("```js\nsum()\n```", 0, 0, {
		...theme,
		highlightCode: (code) => {
			calls.push(code);
			return [code];
		},
	});
	markdown.render(30);
	markdown.setText("```js\nsum()\n```\n\nready");
	expect(markdown.render(12).some((line) => line.trim() === "ready")).toBe(true);
	expect(calls).toEqual(["sum()"]);
	markdown.invalidate();
	markdown.render(12);
	expect(calls).toEqual(["sum()", "sum()"]);
});

test("reused Markdown follows new block spacing and changed reference links", () => {
	setCapabilities({ images: null, trueColor: false, hyperlinks: false });
	const markdown = new Markdown("# Before", 0, 0, theme);
	markdown.render(30);
	markdown.setText("# Before\nafter");
	expect(markdown.render(30).map((line) => line.trimEnd())).toEqual(["Before", "", "after"]);
	markdown.setText("[item][target]\n\n[target]: https://one.example");
	markdown.render(80);
	markdown.setText("[item][target]\n\n[target]: https://two.example");
	expect(markdown.render(80).join("\n")).toContain("https://two.example");
});

afterEach(() => {
	resetCapabilitiesCache();
	setImageTranscoder(undefined);
});

test("wrapping retains an over-wide plain indent while discarding styled whitespace", () => {
	for (const width of [1, 4, 80]) {
		const spaces = " ".repeat(width + 1);
		expect(wrapTextWithAnsi(spaces + "m", width)).toEqual(["", "m"]);
		expect(new Text(spaces + "m", 0, 0).render(width)).toEqual([" ".repeat(width), "m" + " ".repeat(width - 1)]);
		expect(wrapTextWithAnsi("\x1b[31m" + spaces + "\x1b[0mm", width).map(stripTerminalSequences)).toEqual(["m"]);
	}
});

test("Markdown applies emphasis beside CJK punctuation without changing Latin delimiter rules", () => {
	const emphasisTheme: MarkdownTheme = {
		...theme,
		bold: (text) => `<strong>${text}</strong>`,
		italic: (text) => `<em>${text}</em>`,
	};
	for (const [input, expected] of [
		["**任务完成。**继续", "<strong>任务完成。</strong>继续"],
		["说明**「结果」**内容", "说明<strong>「结果」</strong>内容"],
		["*確認。*次へ", "<em>確認。</em>次へ"],
		["**等待：**12 秒", "<strong>等待：</strong>12 秒"],
		["**done.**Next step", "**done.**Next step"],
	]) {
		expect(
			new Markdown(input!, 0, 0, emphasisTheme).render(80).map((line) => stripTerminalSequences(line).trimEnd()),
		).toEqual([expected]);
	}
});

test("bare links stop at CJK punctuation while explicit link destinations retain it", () => {
	setCapabilities({ images: null, trueColor: true, hyperlinks: true });
	const bare = new Markdown("https://example.com。后续", 0, 0, theme).render(70).join("");
	expect(bare).toContain("\x1b]8;;https://example.com\x1b\\");
	expect(bare).toContain("\x1b]8;;\x1b\\。后续");
	const explicit = new Markdown("[文档](https://example.com/中文，路径)", 0, 0, theme).render(70).join("");
	expect(explicit).toContain("\x1b]8;;https://example.com/中文，路径\x1b\\");
});

test("display math keeps its source delimiters when the rendered formula does not fit", () => {
	const text = "\\[\n\\frac{a}{b}+\\frac{c}{d}+\\frac{e}{f}\n\\]";
	const lines = new Markdown(text, 0, 0, theme).render(5).map((line) => stripTerminalSequences(line).trimEnd());
	expect(lines[0]).toBe("\\[");
	expect(lines).toContain("\\]");
});

test("Markdown renders structured text, invokes highlighting and invalidates streamed content", () => {
	const markdown = new Markdown("## Work\n\n**done** and `code`\n\n```ts\nlet x = 1;\n```", 0, 0, {
		...theme,
		highlightCode: (code, language) => [`${language}>${code}`],
	});
	expect(markdown.render(40).map((line) => stripTerminalSequences(line).trimEnd())).toEqual([
		"Work",
		"",
		"done and code",
		"",
		"```ts",
		"  ts>let x = 1;",
		"```",
	]);
	markdown.setText("A $x^2$ grows.\n\n> quoted\n\n- first\n- second");
	const lines = markdown.render(30).map((line) => stripTerminalSequences(line).trimEnd());
	expect(lines).toEqual(["A x² grows.", "", "│ quoted", "", "- first", "- second"]);
	markdown.setText("```js\nconst value = 1;\n``");
	expect(markdown.render(40).map((line) => stripTerminalSequences(line).trimEnd())).toEqual([
		"```js",
		"  js>const value = 1;",
		"```",
	]);
});

test("Markdown tables and transforms respect their available width after a resize", () => {
	const markdown = new Markdown("| Name | State |\n| --- | --- |\n| task | done |", 1, 0, theme, undefined, {
		transform: (text, width) => (width < 15 ? "narrow" : text),
	});
	const wide = markdown.render(30).map((line) => stripTerminalSequences(line).trim());
	expect(wide.join("\n")).toContain("Name");
	expect(wide.join("\n")).toContain("task");
	expect(wide.join("\n")).toContain("done");
	expect(markdown.render(12).map((line) => stripTerminalSequences(line).trimEnd())).toEqual([" narrow"]);
});

test("math notation covers scripts, grouping, roots, fractions and unsupported input", () => {
	for (const [input, expected] of [
		["x_1^2", "x₁²"],
		["\\sqrt{x}", "√x"],
		["\\frac{a+b}{c}", "(a+b)/c"],
		["\\mathbb{R}", "ℝ"],
		["\\alpha \\leq \\beta", "α ≤ β"],
	])
		expect(renderLatex(input!)).toBe(expected);
	expect(renderLatex("\\frac{a}{b}", { display: true })).toBe("a\n─\nb");
	expect(renderLatex("\\unsupported{a}")).toBeUndefined();
});

test("color conversion and styling produce explicit truecolor and indexed sequences", () => {
	expect(colorToHex(parseColor("#0f8"))).toBe("#00ff88");
	expect(colorToHex(indexedColor(244))).toBe("#808080");
	expect(colorToHex(mixColors(rgbColor(255, 0, 0), rgbColor(0, 0, 255), 0.5, "srgb"))).toBe("#800080");
	expect(colorToHex(okhslColor(180, 0, 0))).toBe("#000000");
	expect(colorToHex(okhslColor(180, 0, 1))).toBe("#ffffff");
	expect(mixColors(oklchColor(0.5, 0.1, 350), oklchColor(0.5, 0.1, 10), 0.5)).toEqual({
		kind: "oklch",
		l: 0.5,
		c: 0.1,
		h: 0,
	});
	expect(foregroundAnsi(indexedColor(9), "256color")).toBe("\x1b[38;5;9m");
	expect(backgroundAnsi(rgbColor(1, 2, 3), "truecolor")).toBe("\x1b[48;2;1;2;3m");
	expect(styleText("ok", { fg: rgbColor(1, 2, 3), bold: true }, "truecolor")).toBe(
		"\x1b[38;2;1;2;3m\x1b[1mok\x1b[22m\x1b[39m",
	);
	expect(() => indexedColor(256)).toThrow();
	expect(() => rgbColor(-1, 0, 0)).toThrow();
	expect(() => parseColor("invalid")).toThrow();
});

test("styled Unicode text stays within cell boundaries and closes hyperlinks before truncation", () => {
	const text = "\x1b[31mA界🙂Z\x1b[39m";
	expect(visibleWidth(text)).toBe(6);
	expect(stripTerminalSequences(sliceByColumn(text, 1, 4, true))).toBe("界🙂");
	expect(wrapTextWithAnsi(text, 3).map(stripTerminalSequences)).toEqual(["A界", "🙂Z"]);
	const link = "\x1b]8;;https://example.test\x07abcdef\x1b]8;;\x07";
	expect(stripTerminalSequences(truncateToWidth(link, 4, "…"))).toBe("abc…");
	expect(truncateToWidth(link, 4, "…")).toContain("\x1b]8;;\x07\x1b[0m…");
});

test("image components select text, Kitty and iTerm rendering without losing dimensions", () => {
	expect(getImageDimensions(png, "image/png")).toEqual({ widthPx: 1, heightPx: 1 });
	setCapabilities({ images: null, trueColor: true, hyperlinks: false });
	const image = new Image(png, "image/png", { fallbackColor: plain });
	expect(image.render(50).map(stripTerminalSequences).join("")).toBe("[Image: [image/png] 1x1]");
	setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
	image.invalidate();
	expect(image.render(30)[0]).toContain("\x1b_G");
	expect(image.getImageId()).toBeGreaterThan(0);
	setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: false });
	image.invalidate();
	expect(image.render(30).join("")).toContain("\x1b]1337;File=");
});

test("unknown image dimensions use the fallback size and repeated rendering reuses the frame", () => {
	setCapabilities({ images: null, trueColor: true, hyperlinks: false });
	const color = vi.fn(plain);
	const image = new Image("unrecognized", "image/unknown", { fallbackColor: color });
	const expected = ["[Image: [image/unknown] 800x600]"];
	expect(image.render(80)).toEqual(expected);
	expect(image.render(80)).toEqual(expected);
	expect(color).toHaveBeenCalledTimes(1);
	image.invalidate();
	expect(image.render(80)).toEqual(expected);
	expect(color).toHaveBeenCalledTimes(2);
});

test("a one-cell iTerm image needs no cursor movement", () => {
	setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: false });
	const image = new Image(png, "image/png", { fallbackColor: plain }, { maxWidthCells: 1, maxHeightCells: 1 });
	const lines = image.render(10);
	expect(lines).toHaveLength(1);
	expect(lines[0]).toContain("\x1b]1337;File=");
	expect(lines[0]).not.toMatch(/\x1b\[\d+A/);
});

test("Kitty conversion caches successful and rejected images and evicts older entries", () => {
	setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
	const transcode = vi.fn((data: string) => (data === "rejected" ? null : png));
	const draw = (data: string) =>
		new Image(data, "image/jpeg", { fallbackColor: plain }, {}, { widthPx: 2, heightPx: 2 }).render(40).join("");
	setImageTranscoder(transcode);
	expect(draw("first")).toContain("\x1b_G");
	expect(draw("first")).toContain("\x1b_G");
	expect(transcode.mock.calls).toEqual([["first", "image/jpeg"]]);
	expect(draw("rejected")).toContain("[image/jpeg] 2x2");
	expect(draw("rejected")).toContain("[image/jpeg] 2x2");
	expect(transcode).toHaveBeenCalledTimes(2);
	for (let index = 0; index < 33; index++) draw("image-" + index);
	expect(transcode).toHaveBeenCalledTimes(35);
	draw("first");
	expect(transcode).toHaveBeenCalledTimes(36);
	setImageTranscoder(undefined);
	expect(draw("without-transcoder")).toContain("[image/jpeg] 2x2");
	expect(transcode).toHaveBeenCalledTimes(36);
});

test("truncation preserves the complete styled ellipsis when it fits", () => {
	expect(truncateToWidth("long label", 3, "\x1b[31m.\x1b[0m")).toBe("lo\x1b[0m\x1b[31m.\x1b[0m\x1b[0m");
});

test("a complete style following an incomplete CSI prefix survives wrapping and slicing", () => {
	const text = "\x1b[\x1b[31mabcdef";
	expect(wrapTextWithAnsi(text, 3)).toEqual(["\x1b[\x1b[31mabc", "\x1b[31mdef"]);
	expect(extractSegments(text, 1, 3, 2)).toEqual({
		before: "\x1b[\x1b[31ma",
		beforeWidth: 1,
		after: "\x1b[31mde",
		afterWidth: 2,
	});
});

test("an ellipsis filling the available width discards zero-width source characters", () => {
	expect(truncateToWidth("\nlong", 1, "…")).toBe("\x1b[0m…\x1b[0m");
	expect(truncateToWidth("\u0301long", 1, "…")).toBe("\x1b[0m…\x1b[0m");
});

test("Markdown rounds fractional vertical padding up to a whole display row", () => {
	expect(new Markdown("ready", 0, 0.5, theme).render(5)).toEqual(["     ", "ready", "     "]);
});

test("deep quotes stop adding borders when the remaining width is too narrow", () => {
	const markdown = new Markdown(">".repeat(12) + "x", 0, 0, theme);
	const lines = markdown.render(5).map(stripTerminalSequences);
	expect(lines).toHaveLength(1);
	expect(lines[0]?.trimEnd()).toBe("│ │ x");
});

test("truncation measures graphemes independently across styling boundaries", () => {
	expect(truncateToWidth("🇦\x1b[31m🇦", 2, "")).toBe("🇦\x1b[0m");
	expect(truncateToWidth("x🇦\x1b[31m🇦", 3, "")).toBe("x🇦\x1b[0m");
	expect(truncateToWidth("🇦\x1b[31m🇦", 4, "")).toBe("🇦\x1b[31m🇦");
});

test("ASCII formatting does not perform Unicode segmentation", () => {
	const segmentation = vi.spyOn(getGraphemeSegmenter(), "segment");
	try {
		const text = "ordinary words ".repeat(20);
		const lines = wrapTextWithAnsi(`\x1b[31m${text}\x1b[39m`, 40);
		expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
		expect(stripTerminalSequences("\x1b[31mplain text\x1b[39m")).toBe("plain text");
		expect(normalizeTerminalOutput("\x1b[31mplain text\x1b[39m")).toBe("\x1b[31mplain text\x1b[39m");
		expect(segmentation).not.toHaveBeenCalled();
	} finally {
		segmentation.mockRestore();
	}
});

test("fast formatting preserves combining clusters and tabs inside control sequences", () => {
	expect(sliceByColumn("a\u0301z", 0, 1, true)).toBe("a\u0301");
	expect(wrapTextWithAnsi("a\u0301界", 2)).toEqual(["a\u0301", "界"]);
	expect(normalizeTerminalOutput("\x1b]8;;https://example.com/\t\x07x\t")).toBe(
		"\x1b]8;;https://example.com/\t\x07x   ",
	);
});
