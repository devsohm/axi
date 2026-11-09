import type { Principal } from "../data/index.ts";
import { defineFacet, type Facet } from "../host/index.ts";
import { defineRegistry } from "../registries/index.ts";

export const BASE_ROLES = ["accent", "bg", "fg", "muted", "error", "warning", "success"] as const;
export type BaseRole = (typeof BASE_ROLES)[number];
export type Theme = {
	readonly id: string;
	readonly name: string;
	readonly mode: "dark" | "light";
	readonly colors: Readonly<Record<BaseRole, string>> & Readonly<Record<string, string>>;
	readonly web?: Readonly<Record<string, string>>;
	readonly tui?: Readonly<Record<string, string>>;
};
export type ThemePick = { readonly dark: string | null; readonly light: string | null };
export type ColorDepth = "truecolor" | "256";
export const Themes = defineRegistry<Theme, readonly Theme[]>("objects.themes", { version: 1 });
export function themesFacet<P extends Principal>(): Facet<P> {
	return defineFacet<P>((host) => host.serve(Themes, { compose: (rows) => rows.map((row) => row.value) }));
}
export const FALLBACK_THEMES: Readonly<Record<Theme["mode"], Theme>> = {
	dark: {
		id: "objects.dark",
		name: "Dark",
		mode: "dark",
		colors: {
			bg: "#16181d",
			fg: "#e6e6e6",
			accent: "#4c9aff",
			muted: "#8a8f98",
			success: "#3ecf8e",
			error: "#ff6b6b",
			warning: "#f0b429",
		},
	},
	light: {
		id: "objects.light",
		name: "Light",
		mode: "light",
		colors: {
			bg: "#ffffff",
			fg: "#1c1e21",
			accent: "#0b62d6",
			muted: "#6b7280",
			success: "#1b7f4b",
			error: "#c62828",
			warning: "#b26a00",
		},
	},
};
export function activeTheme(themes: readonly Theme[], pick: ThemePick, mode: Theme["mode"]): Theme {
	return (
		themes.find((theme) => theme.mode === mode && theme.id === pick[mode]) ??
		themes.find((theme) => theme.mode === mode) ??
		FALLBACK_THEMES[mode]
	);
}
export function themeVariables(theme: Theme): Readonly<Record<string, string>> {
	return Object.fromEntries(
		Object.entries({ ...theme.colors, ...theme.web }).map(([name, color]) => [`--${name}`, color]),
	);
}
function paletteIndex(rgb: readonly number[]): number {
	const levels = [0, 95, 135, 175, 215, 255];
	const positions = rgb.map((channel) =>
		levels.reduce((best, value, i) => (Math.abs(value - channel) < Math.abs(levels[best]! - channel) ? i : best), 0),
	);
	const cube = 16 + positions[0]! * 36 + positions[1]! * 6 + positions[2]!;
	const shade = Math.min(23, Math.max(0, Math.round((rgb.reduce((sum, channel) => sum + channel, 0) / 3 - 8) / 10)));
	let cubeDistance = 0,
		greyDistance = 0;
	for (let i = 0; i < 3; i++) {
		cubeDistance += (rgb[i]! - levels[positions[i]!]!) ** 2;
		greyDistance += (rgb[i]! - (8 + shade * 10)) ** 2;
	}
	return greyDistance < cubeDistance ? 232 + shade : cube;
}
export function terminalColor(theme: Theme, role: string, depth: ColorDepth, layer: "fg" | "bg"): string {
	const color = theme.tui?.[role] ?? theme.colors[role] ?? FALLBACK_THEMES[theme.mode].colors[role];
	const prefix = layer === "fg" ? 38 : 48;
	if (color !== undefined && /^\d{1,3}$/.test(color) && +color < 256) return `${prefix};5;${color}`;
	if (!color || !/^#[a-f\d]{6}$/i.test(color)) return layer === "fg" ? "39" : "49";
	const rgb = [1, 3, 5].map((start) => parseInt(color.slice(start, start + 2), 16));
	return depth === "truecolor" ? `${prefix};2;${rgb.join(";")}` : `${prefix};5;${paletteIndex(rgb)}`;
}
