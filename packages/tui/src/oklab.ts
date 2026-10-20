import type { RgbColor } from "./terminal-colors.ts";
type Vector = [number, number, number];
type Matrix = [Vector, Vector, Vector];
const RGB_LMS: Matrix = [
	[0.4122214694707629, 0.5363325372617349, 0.0514459932675022],
	[0.2119034958178251, 0.6806995506452344, 0.1073969535369405],
	[0.0883024591900564, 0.2817188391361215, 0.6299787016738222],
];
const LMS_LAB: Matrix = [
	[0.210454268309314, 0.793617774702305, -0.0040720430116193],
	[1.9779985324311684, -2.42859224204858, 0.450593709617411],
	[0.0259040424655478, 0.7827717124575296, -0.8086757549230774],
];
const LAB_LMS: Matrix = [
	[1, 0.3963377773761749, 0.2158037573099136],
	[1, -0.1055613458156586, -0.0638541728258133],
	[1, -0.0894841775298119, -1.2914855480194092],
];
const LMS_RGB: Matrix = [
	[4.0767416360759583, -3.3077115392580629, 0.2309699031821043],
	[-1.2684379732850315, 2.6097573492876882, -0.341319376002657],
	[-0.0041960761386756, -0.7034186179359362, 1.7076146940746117],
];
function dot(row: Vector, value: Vector): number {
	return row[0] * value[0] + row[1] * value[1] + row[2] * value[2];
}
function multiply(matrix: Matrix, value: Vector): Vector {
	return [dot(matrix[0], value), dot(matrix[1], value), dot(matrix[2], value)];
}
function map(value: Vector, fn: (value: number, index: number) => number): Vector {
	return [fn(value[0], 0), fn(value[1], 1), fn(value[2], 2)];
}
const K1 = 0.206,
	K2 = 0.03,
	K3 = (1 + K1) / (1 + K2);
export function oklabToOkhslLightness(x: number): number {
	return 0.5 * (K3 * x - K1 + Math.sqrt((K3 * x - K1) ** 2 + 4 * K2 * K3 * x));
}
function encode(x: number): number {
	return x > 0.0031308 ? 1.055 * x ** (1 / 2.4) - 0.055 : 12.92 * x;
}
function decode(x: number): number {
	return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
}
export function oklabToLinearSrgb(lab: Vector): Vector {
	return multiply(
		LMS_RGB,
		map(multiply(LAB_LMS, lab), (value) => value ** 3),
	);
}
export function rgbToOklab(rgb: RgbColor): Vector {
	return multiply(
		LMS_LAB,
		map(multiply(RGB_LMS, [decode(rgb.r / 255), decode(rgb.g / 255), decode(rgb.b / 255)]), Math.cbrt),
	);
}
export function linearSrgbToRgb(value: Vector): RgbColor {
	const [r, g, b] = map(value, (item) => Math.round(Math.min(1, Math.max(0, encode(item))) * 255));
	return { r, g, b };
}
function slopes(a: number, b: number): Vector {
	return [
		LAB_LMS[0][1] * a + LAB_LMS[0][2] * b,
		LAB_LMS[1][1] * a + LAB_LMS[1][2] * b,
		LAB_LMS[2][1] * a + LAB_LMS[2][2] * b,
	];
}
function cusp(a: number, b: number): [number, number] {
	const channel = -1.8817031 * a - 0.80936501 * b > 1 ? 0 : 1.8144408 * a - 1.19445267 * b > 1 ? 1 : 2;
	const coefficients = [
		[1.19086277, 1.76576728, 0.59662641, 0.75515197, 0.56771245],
		[0.73956515, -0.45954404, 0.08285427, 0.12541073, -0.14503204],
		[1.35733652, -0.00915799, -1.1513021, -0.50559606, 0.00692167],
	][channel]!;
	const saturation =
		coefficients[0]! +
		coefficients[1]! * a +
		coefficients[2]! * b +
		coefficients[3]! * a * a +
		coefficients[4]! * a * b;
	const k = slopes(a, b),
		base = map(k, (value) => 1 + saturation * value),
		weights = LMS_RGB[channel]!;
	const f = dot(
			weights,
			map(base, (value) => value ** 3),
		),
		first = dot(
			weights,
			map(base, (value, index) => 3 * k[index]! * value ** 2),
		),
		second = dot(
			weights,
			map(base, (value, index) => 6 * k[index]! ** 2 * value),
		);
	const maximum = saturation - (f * first) / (first * first - 0.5 * f * second);
	const light = Math.cbrt(1 / Math.max(...oklabToLinearSrgb([1, maximum * a, maximum * b])));
	return [light, light * maximum];
}
function chromaStops(light: number, a: number, b: number): [number, number, number] {
	const [peakL, peakC] = cusp(a, b);
	let maximum: number;
	if (light <= peakL) maximum = (peakC * light) / peakL;
	else {
		const t = (peakC * (light - 1)) / (peakL - 1),
			k = slopes(a, b),
			base = map(k, (value) => light + t * value);
		const cubes = map(base, (value) => value ** 3),
			first = map(base, (value, index) => 3 * k[index]! * value ** 2),
			second = map(base, (value, index) => 6 * k[index]! ** 2 * value);
		maximum =
			t +
			Math.min(
				...LMS_RGB.map((row) => {
					const f = dot(row, cubes) - 1,
						f1 = dot(row, first),
						f2 = dot(row, second),
						u = f1 / (f1 * f1 - 0.5 * f * f2);
					return u >= 0 ? -f * u : Number.MAX_VALUE;
				}),
			);
	}
	const k = maximum / Math.min(light * (peakC / peakL), (1 - light) * (peakC / (1 - peakL)));
	const midS =
		0.11516993 +
		1 /
			(7.4477897 +
				4.1590124 * b +
				a *
					(-2.19557347 +
						1.75198401 * b +
						a * (-2.13704948 - 10.02301043 * b + a * (-4.24894561 + 5.38770819 * b + 4.69891013 * a))));
	const midT =
		0.11239642 +
		1 /
			(1.6132032 -
				0.68124379 * b +
				a *
					(0.40370612 +
						0.90148123 * b +
						a * (-0.27087943 + 0.6122399 * b + a * (0.00299215 - 0.45399568 * b - 0.14661872 * a))));
	return [
		Math.sqrt(1 / (1 / (light * 0.4) ** 2 + 1 / ((1 - light) * 0.8) ** 2)),
		0.9 * k * Math.sqrt(Math.sqrt(1 / (1 / (light * midS) ** 4 + 1 / ((1 - light) * midT) ** 4))),
		maximum,
	];
}
export function okhslToRgb(hue: number, saturation: number, lightness: number): RgbColor {
	const light = (lightness * lightness + K1 * lightness) / (K3 * (lightness + K2));
	let lab: Vector = [light, 0, 0];
	if (light > 0 && light < 1 && saturation > 0) {
		const angle = (2 * Math.PI * (((hue % 360) + 360) % 360)) / 360,
			a = Math.cos(angle),
			b = Math.sin(angle),
			[zero, mid, max] = chromaStops(light, a, b);
		let chroma: number;
		if (saturation < 0.8) {
			const t = 1.25 * saturation,
				k = 0.8 * zero;
			chroma = (t * k) / (1 - (1 - k / mid) * t);
		} else {
			const t = 5 * (saturation - 0.8),
				k = (0.2 * mid ** 2 * 1.25 ** 2) / zero;
			chroma = mid + (t * k) / (1 - (1 - k / (max - mid)) * t);
		}
		lab = [light, chroma * a, chroma * b];
	}
	return linearSrgbToRgb(oklabToLinearSrgb(lab));
}
export function rgbToOkhsl(rgb: RgbColor): { h: number; s: number; l: number } {
	const [light, a, b] = rgbToOklab(rgb),
		chroma = Math.hypot(a, b),
		l = oklabToOkhslLightness(light);
	if (chroma < 1e-9 || l <= 0 || l >= 1) return { h: 0, s: 0, l };
	const h = ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360,
		[zero, mid, max] = chromaStops(light, a / chroma, b / chroma);
	let saturation: number;
	if (chroma < mid) {
		const k = 0.8 * zero;
		saturation = 0.8 * (chroma / (k + (1 - k / mid) * chroma));
	} else {
		const k = (0.2 * mid ** 2 * 1.25 ** 2) / zero,
			offset = chroma - mid;
		saturation = 0.8 + 0.2 * (offset / (k + (1 - k / (max - mid)) * offset));
	}
	return { h, s: Math.min(1, Math.max(0, saturation)), l };
}
