import { afterEach, expect, test } from "vitest";
import { Markdown, type MarkdownTheme } from "../src/components/markdown.ts";
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
	stripTerminalSequences,
	visibleWidth,
	sliceByColumn,
	truncateToWidth,
	wrapTextWithAnsi,
} from "../src/utils.ts";
const plain = (text: string) => text;
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
afterEach(() => {
	resetCapabilitiesCache();
	setImageTranscoder(undefined);
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
	const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4c8AAAAASUVORK5CYII=";
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
