import { expect, test } from "vitest";
import { colorToOkhsl, okhslColor, oklchColor, rgbColor } from "../src/colors.ts";

test("color conversion preserves the full saturation value for dark cyan", () => {
	expect(colorToOkhsl(rgbColor(0, 17, 17))).toEqual({
		h: 194.76895989798186,
		s: 0.9999997002360035,
		l: 0.06683884193169494,
	});
});

test("color constructors reject non-finite channels before checking channel ranges", () => {
	expect(() => oklchColor(-1, NaN, 0)).toThrow("c must be finite");
	expect(() => oklchColor(-1, 0, Infinity)).toThrow("h must be finite");
	expect(() => okhslColor(0, -1, NaN)).toThrow("l must be finite");
});
