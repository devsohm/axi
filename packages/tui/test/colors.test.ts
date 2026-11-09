import { expect, test } from "vitest";
import { colorToOkhsl, colorToRgb, okhslColor, oklchColor, rgbColor } from "../src/colors.ts";

test("color conversion preserves the full saturation value for dark cyan", () => {
	expect(colorToOkhsl(rgbColor(0, 17, 17))).toEqual({
		h: 194.76895989798186,
		s: expect.closeTo(0.9999997002360035, 15),
		l: 0.06683884193169494,
	});
});

test("color constructors reject non-finite channels before checking channel ranges", () => {
	expect(() => oklchColor(-1, NaN, 0)).toThrow("c must be finite");
	expect(() => oklchColor(-1, 0, Infinity)).toThrow("h must be finite");
	expect(() => okhslColor(0, -1, NaN)).toThrow("l must be finite");
});

test("OKHSL round trips preserve interior RGB colors without gamut clipping", () => {
	const levels = [32, 96, 160, 224];
	for (const r of levels)
		for (const g of levels)
			for (const b of levels) {
				const original = { r, g, b };
				const hsl = colorToOkhsl(rgbColor(r, g, b));
				const restored = colorToRgb(okhslColor(hsl.h, hsl.s, hsl.l));
				for (const channel of ["r", "g", "b"] as const)
					expect(
						Math.abs(restored[channel] - original[channel]),
						JSON.stringify({ original, restored }),
					).toBeLessThanOrEqual(1);
			}
});

test("hue wrapping preserves colors at every saturation and lightness boundary", () => {
	for (const hue of [0, 30, 90, 150, 210, 270, 330])
		for (const saturation of [0, 0.1, 0.79, 0.8, 0.95, 1])
			for (const lightness of [0, 0.05, 0.5, 0.95, 1]) {
				const expected = colorToRgb(okhslColor(hue, saturation, lightness));
				expect(colorToRgb(okhslColor(hue - 720, saturation, lightness))).toEqual(expected);
				expect(colorToRgb(okhslColor(hue + 720, saturation, lightness))).toEqual(expected);
				for (const value of Object.values(expected)) {
					expect(Number.isInteger(value)).toBe(true);
					expect(value).toBeGreaterThanOrEqual(0);
					expect(value).toBeLessThanOrEqual(255);
				}
			}
});

test("achromatic colors ignore hue and their lightness increases from black to white", () => {
	let previous = -1;
	for (let step = 0; step <= 100; step++) {
		const gray = colorToRgb(okhslColor(0, 0, step / 100));
		expect(gray.r).toBe(gray.g);
		expect(gray.g).toBe(gray.b);
		expect(gray.r).toBeGreaterThanOrEqual(previous);
		expect(colorToRgb(okhslColor(217, 0, step / 100))).toEqual(gray);
		previous = gray.r;
	}
	expect(colorToRgb(okhslColor(0, 1, 0))).toEqual({ r: 0, g: 0, b: 0 });
	expect(colorToRgb(okhslColor(0, 1, 1))).toEqual({ r: 255, g: 255, b: 255 });
});
