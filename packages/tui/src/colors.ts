import { linearSrgbToRgb, okhslToRgb, oklabToLinearSrgb, rgbToOkhsl, rgbToOklab } from "./oklab.ts";
import type { RgbColor } from "./terminal-colors.ts";
export interface IndexedColor {
	readonly kind: "indexed";
	readonly index: number;
}
export interface RgbColorValue {
	readonly kind: "rgb";
	readonly r: number;
	readonly g: number;
	readonly b: number;
}
export interface OklchColorValue {
	readonly kind: "oklch";
	readonly l: number;
	readonly c: number;
	readonly h: number;
}
export type Color = IndexedColor | RgbColorValue | OklchColorValue;
export type TerminalColorMode = "256color" | "truecolor";
export type ColorMixSpace = "oklch" | "srgb";
export interface OklchChannels {
	l: number;
	c: number;
	h: number;
}
export interface OkhslChannels {
	h: number;
	s: number;
	l: number;
}
export interface TextAttributes {
	bold?: boolean;
	dim?: boolean;
	italic?: boolean;
	underline?: boolean;
	inverse?: boolean;
	strikethrough?: boolean;
}
export interface TextStyle extends TextAttributes {
	fg?: Color;
	bg?: Color;
}
function finite(value: number, name: string): void {
	if (!Number.isFinite(value)) throw new Error(`${name} must be finite`);
}
function unit(value: number, name: string, max = 1): void {
	finite(value, name);
	if (value < 0 || value > max) throw new Error(`${name} must be between 0 and ${max}: ${value}`);
}
export function indexedColor(index: number): IndexedColor {
	if (!Number.isInteger(index) || index < 0 || index > 255)
		throw new Error(`ANSI color index must be an integer from 0 to 255: ${index}`);
	return Object.freeze({ kind: "indexed", index });
}
export function rgbColor(r: number, g: number, b: number): RgbColorValue {
	unit(r, "r", 255);
	unit(g, "g", 255);
	unit(b, "b", 255);
	return Object.freeze({ kind: "rgb", r, g, b });
}
export function oklchColor(l: number, c: number, h: number): OklchColorValue {
	finite(l, "l");
	finite(c, "c");
	finite(h, "h");
	if (l < 0 || l > 1) throw new Error(`l must be between 0 and 1: ${l}`);
	if (c < 0) throw new Error(`c must not be negative: ${c}`);
	return Object.freeze({ kind: "oklch", l, c, h: ((h % 360) + 360) % 360 });
}
export function okhslColor(h: number, s: number, l: number): RgbColorValue {
	finite(h, "h");
	finite(s, "s");
	finite(l, "l");
	if (s < 0 || s > 1) throw new Error(`s must be between 0 and 1: ${s}`);
	if (l < 0 || l > 1) throw new Error(`l must be between 0 and 1: ${l}`);
	const rgb = okhslToRgb(h, s, l);
	return rgbColor(rgb.r, rgb.g, rgb.b);
}
const NUMBER = "[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:e[+-]?\\d+)?";
const LCH = new RegExp(`^oklch\\(\\s*(${NUMBER})(%)?\\s+(${NUMBER})\\s+(${NUMBER})(?:deg)?\\s*\\)$`, "i");
const HSL = new RegExp(`^okhsl\\(\\s*(${NUMBER})(?:deg)?\\s+(${NUMBER})(%)?\\s+(${NUMBER})(%)?\\s*\\)$`, "i");
export function parseColor(value: string | number): Color {
	if (typeof value === "number") return indexedColor(value);
	const hex = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(value);
	if (hex) {
		const digits = hex[1]!.length === 3 ? [...hex[1]!].map((digit) => digit + digit).join("") : hex[1]!;
		return rgbColor(
			Number.parseInt(digits.slice(0, 2), 16),
			Number.parseInt(digits.slice(2, 4), 16),
			Number.parseInt(digits.slice(4, 6), 16),
		);
	}
	const lch = LCH.exec(value);
	if (lch) return oklchColor(Number(lch[1]) / (lch[2] ? 100 : 1), Number(lch[3]), Number(lch[4]));
	const hsl = HSL.exec(value);
	if (hsl) return okhslColor(Number(hsl[1]), Number(hsl[2]) / (hsl[3] ? 100 : 1), Number(hsl[4]) / (hsl[5] ? 100 : 1));
	throw new Error(`Invalid color value: ${value}`);
}
const basic = [
	0x000000, 0x800000, 0x008000, 0x808000, 0x000080, 0x800080, 0x008080, 0xc0c0c0, 0x808080, 0xff0000, 0x00ff00,
	0xffff00, 0x0000ff, 0xff00ff, 0x00ffff, 0xffffff,
];
const cube = [0, 95, 135, 175, 215, 255],
	grays = Array.from({ length: 24 }, (_, index) => 8 + index * 10);
export function colorToRgb(color: Color): RgbColor {
	if (color.kind === "rgb") return { r: color.r, g: color.g, b: color.b };
	if (color.kind === "indexed") {
		const index = color.index;
		if (index < 16) {
			const value = basic[index]!;
			return { r: value >>> 16, g: (value >>> 8) & 255, b: value & 255 };
		}
		if (index < 232) {
			const value = index - 16;
			return { r: cube[Math.floor(value / 36)]!, g: cube[Math.floor((value % 36) / 6)]!, b: cube[value % 6]! };
		}
		const value = 8 + (index - 232) * 10;
		return { r: value, g: value, b: value };
	}
	const radians = (color.h * Math.PI) / 180,
		cos = Math.cos(radians),
		sin = Math.sin(radians);
	const at = (chroma: number) => oklabToLinearSrgb([color.l, chroma * cos, chroma * sin]);
	const inGamut = (values: number[]) => values.every((value) => value >= -1e-7 && value <= 1 + 1e-7);
	let linear = at(color.c);
	if (inGamut(linear)) return linearSrgbToRgb(linear);
	linear = at(0);
	let low = 0,
		high = color.c;
	for (let index = 0; index < 20; index++) {
		const mid = (low + high) / 2,
			trial = at(mid);
		if (inGamut(trial)) {
			low = mid;
			linear = trial;
		} else high = mid;
	}
	return linearSrgbToRgb(linear);
}
export function colorToOklch(color: Color): OklchChannels {
	if (color.kind === "oklch") return { l: color.l, c: color.c, h: color.h };
	const [l, a, b] = rgbToOklab(colorToRgb(color));
	return { l, c: Math.hypot(a, b), h: ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360 };
}
export function colorToOkhsl(color: Color): OkhslChannels {
	return rgbToOkhsl(colorToRgb(color));
}
export function colorToHex(color: Color): string {
	const rgb = colorToRgb(color);
	return "#" + [rgb.r, rgb.g, rgb.b].map((value) => Math.round(value).toString(16).padStart(2, "0")).join("");
}
export function mixColors(first: Color, second: Color, amount: number, space: ColorMixSpace = "oklch"): Color {
	unit(amount, "amount");
	if (space === "srgb") {
		const a = colorToRgb(first),
			b = colorToRgb(second);
		return rgbColor(a.r + (b.r - a.r) * amount, a.g + (b.g - a.g) * amount, a.b + (b.b - a.b) * amount);
	}
	const a = colorToOklch(first),
		b = colorToOklch(second),
		hue = a.c < 1e-7 ? b.h : a.h,
		target = b.c < 1e-7 ? hue : b.h;
	return oklchColor(
		a.l + (b.l - a.l) * amount,
		a.c + (b.c - a.c) * amount,
		hue + (((target - hue + 540) % 360) - 180) * amount,
	);
}
function closest(values: readonly number[], target: number): number {
	let index = 0,
		distance = Infinity;
	for (let i = 0; i < values.length; i++) {
		const next = Math.abs(target - values[i]!);
		if (next < distance) {
			distance = next;
			index = i;
		}
	}
	return index;
}
function ansiIndex(rgb: RgbColor): number {
	const r = closest(cube, rgb.r),
		g = closest(cube, rgb.g),
		b = closest(cube, rgb.b),
		gray = closest(grays, Math.round(0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b));
	const distance = (red: number, green: number, blue: number) =>
		(rgb.r - red) ** 2 * 0.299 + (rgb.g - green) ** 2 * 0.587 + (rgb.b - blue) ** 2 * 0.114;
	return Math.max(rgb.r, rgb.g, rgb.b) - Math.min(rgb.r, rgb.g, rgb.b) < 10 &&
		distance(grays[gray]!, grays[gray]!, grays[gray]!) < distance(cube[r]!, cube[g]!, cube[b]!)
		? 232 + gray
		: 16 + 36 * r + 6 * g + b;
}
function ansi(color: Color, mode: TerminalColorMode, background: boolean): string {
	const code = background ? 48 : 38;
	if (color.kind === "indexed") return `\x1b[${code};5;${color.index}m`;
	const rgb = colorToRgb(color);
	return mode === "truecolor"
		? `\x1b[${code};2;${Math.round(rgb.r)};${Math.round(rgb.g)};${Math.round(rgb.b)}m`
		: `\x1b[${code};5;${ansiIndex(rgb)}m`;
}
export function foregroundAnsi(color: Color, mode: TerminalColorMode): string {
	return ansi(color, mode, false);
}
export function backgroundAnsi(color: Color, mode: TerminalColorMode): string {
	return ansi(color, mode, true);
}
export function styleText(text: string, options: TextStyle, mode: TerminalColorMode): string {
	return styleTextWithAnsi(
		text,
		options.fg && foregroundAnsi(options.fg, mode),
		options.bg && backgroundAnsi(options.bg, mode),
		options,
	);
}
export function styleTextWithAnsi(
	text: string,
	fgAnsi: string | undefined,
	bgAnsi: string | undefined,
	options: TextAttributes,
): string {
	let open = (fgAnsi ?? "") + (bgAnsi ?? ""),
		close = (bgAnsi ? "\x1b[49m" : "") + (fgAnsi ? "\x1b[39m" : "");
	if (options.bold) open += "\x1b[1m";
	if (options.dim) open += "\x1b[2m";
	if (options.bold || options.dim) close = "\x1b[22m" + close;
	for (const [key, start, end] of [
		["italic", 3, 23],
		["underline", 4, 24],
		["inverse", 7, 27],
		["strikethrough", 9, 29],
	] as const)
		if (options[key]) {
			open += `\x1b[${start}m`;
			close = `\x1b[${end}m` + close;
		}
	return open + text + close;
}
