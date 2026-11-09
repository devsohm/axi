import { expect, test } from "vitest";
import {
	colorToHex,
	colorToOklch,
	colorToRgb,
	foregroundAnsi,
	indexedColor,
	mixColors,
	okhslColor,
	oklchColor,
	parseColor,
	rgbColor,
	styleText,
} from "../src/colors.ts";
import { TestTerminal } from "./support/terminal.ts";

test("color parsing accepts each documented format and rejects out-of-range channels", () => {
	expect(parseColor(123)).toEqual({ kind: "indexed", index: 123 });
	expect(colorToHex(parseColor("#AbC"))).toBe("#aabbcc");
	expect(colorToHex(parseColor("#01abFE"))).toBe("#01abfe");
	expect(parseColor("oklch(50% 0.2 -10deg)")).toEqual({ kind: "oklch", l: 0.5, c: 0.2, h: 350 });
	expect(parseColor("oklch(5e-1 .2 370)")).toEqual({ kind: "oklch", l: 0.5, c: 0.2, h: 10 });
	expect(parseColor("okhsl(30deg 0% 100%)")).toEqual(rgbColor(255, 255, 255));
	expect(parseColor("okhsl(30 0 .0)")).toEqual(rgbColor(0, 0, 0));
	for (const text of [
		"red",
		"#12",
		"#12345",
		"rgb(1, 2, 3)",
		"oklch(101% 0 0)",
		"oklch(.5 -1 0)",
		"okhsl(0 101% 0%)",
		"okhsl(0 0 -1)",
	])
		expect(() => parseColor(text)).toThrow();
	for (const value of [-1, 256, 0.5, NaN, Infinity]) expect(() => indexedColor(value)).toThrow();
	for (const value of [-1, 256, NaN, Infinity]) expect(() => rgbColor(value, 0, 0)).toThrow();
	for (const value of [-1, 2]) {
		expect(() => oklchColor(value, 0, 0)).toThrow();
		expect(() => okhslColor(0, value, 0)).toThrow();
		expect(() => okhslColor(0, 0, value)).toThrow();
	}
});

test("indexed colors follow the ANSI base palette, six-level cube and grayscale ramp", () => {
	for (const [index, hex] of [
		[0, "#000000"],
		[1, "#800000"],
		[9, "#ff0000"],
		[15, "#ffffff"],
	] as const)
		expect(colorToHex(indexedColor(index))).toBe(hex);
	const levels = [0, 95, 135, 175, 215, 255];
	let index = 16;
	for (const r of levels)
		for (const g of levels) for (const b of levels) expect(colorToRgb(indexedColor(index++))).toEqual({ r, g, b });
	for (let shade = 0; shade < 24; shade++)
		expect(colorToRgb(indexedColor(232 + shade))).toEqual({ r: 8 + shade * 10, g: 8 + shade * 10, b: 8 + shade * 10 });
	expect(foregroundAnsi(rgbColor(255, 0, 0), "256color")).toBe("\x1b[38;5;196m");
	expect(foregroundAnsi(rgbColor(128, 128, 128), "256color")).toBe("\x1b[38;5;244m");
});

test("perceptual conversions retain RGB colors and safely map high chroma into the display gamut", () => {
	for (const [r, g, b] of [
		[0, 0, 0],
		[255, 255, 255],
		[255, 0, 0],
		[0, 255, 0],
		[0, 0, 255],
		[17, 128, 240],
		[123, 25, 88],
	] satisfies [number, number, number][]) {
		const channels = colorToOklch(rgbColor(r, g, b)),
			restored = colorToRgb(oklchColor(channels.l, channels.c, channels.h));
		expect(restored.r).toBeCloseTo(r, 2);
		expect(restored.g).toBeCloseTo(g, 2);
		expect(restored.b).toBeCloseTo(b, 2);
	}
	for (const hue of [0, 60, 120, 180, 240, 300]) {
		const rgb = colorToRgb(oklchColor(0.5, 3, hue));
		for (const value of [rgb.r, rgb.g, rgb.b]) {
			expect(value).toBeGreaterThanOrEqual(0);
			expect(value).toBeLessThanOrEqual(255);
		}
	}
	expect(mixColors(oklchColor(0.5, 0, 0), oklchColor(0.5, 0.2, 120), 0.5)).toEqual(oklchColor(0.5, 0.1, 120));
	expect(mixColors(oklchColor(0.5, 0.2, 120), oklchColor(0.5, 0, 0), 0.5)).toEqual(oklchColor(0.5, 0.1, 120));
	for (const value of [-1, 2, NaN])
		expect(() => mixColors(rgbColor(0, 0, 0), rgbColor(255, 255, 255), value)).toThrow();
});

test("every text-attribute combination affects only its text in a terminal emulator", async () => {
	const terminal = new TestTerminal(4, 1);
	try {
		for (let bits = 0; bits < 64; bits++) {
			const attributes = {
				bold: Boolean(bits & 1),
				dim: Boolean(bits & 2),
				italic: Boolean(bits & 4),
				underline: Boolean(bits & 8),
				inverse: Boolean(bits & 16),
				strikethrough: Boolean(bits & 32),
			};
			terminal.write(
				"\x1b[0m\x1b[H" +
					styleText(
						"a",
						{ ...attributes, fg: rgbColor(255, 0, 0), bg: rgbColor(0, 0, 255) },
						bits % 2 ? "truecolor" : "256color",
					) +
					"z",
			);
			await terminal.screen();
			const line = terminal.emulator.buffer.active.getLine(0),
				first = line?.getCell(0),
				after = line?.getCell(1);
			if (!first || !after) throw new Error("Terminal cells were not rendered");
			expect(first.getChars()).toBe("a");
			expect(after.getChars()).toBe("z");
			expect(
				[
					first.isBold(),
					first.isDim(),
					first.isItalic(),
					first.isUnderline(),
					first.isInverse(),
					first.isStrikethrough(),
				].map(Boolean),
			).toEqual(Object.values(attributes));
			expect(
				[
					after.isBold(),
					after.isDim(),
					after.isItalic(),
					after.isUnderline(),
					after.isInverse(),
					after.isStrikethrough(),
				].some(Boolean),
			).toBe(false);
			expect(after.isFgDefault()).toBe(true);
			expect(after.isBgDefault()).toBe(true);
		}
	} finally {
		terminal.dispose();
	}
});
