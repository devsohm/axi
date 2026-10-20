export interface RgbColor {
	r: number;
	g: number;
	b: number;
}

export type TerminalColorScheme = "dark" | "light";
export interface TerminalColors {
	foreground?: RgbColor;
	background?: RgbColor;
	palette?: RgbColor[];
}
export type OscColorTarget = "foreground" | "background" | number;

function channel(value: string): number | undefined {
	if (!/^[\da-f]+$/i.test(value)) return undefined;
	return Math.round((Number.parseInt(value, 16) * 255) / (16 ** value.length - 1));
}

function parseRgb(value: string): RgbColor | undefined {
	const trimmed = value.trim();
	let channels: string[];
	if (trimmed.startsWith("#")) {
		const hex = trimmed.slice(1);
		if (!/^(?:[\da-f]{6}|[\da-f]{12})$/i.test(hex)) return undefined;
		const size = hex.length / 3;
		channels = [hex.slice(0, size), hex.slice(size, size * 2), hex.slice(size * 2)];
	} else channels = trimmed.replace(/^rgba?:/i, "").split("/");
	if (channels.length < 3) return undefined;
	const [r, g, b] = channels.slice(0, 3).map(channel);
	return r === undefined || g === undefined || b === undefined ? undefined : { r, g, b };
}

export function parseOscColorResponse(data: string): { target: OscColorTarget; rgb: RgbColor | undefined } | undefined {
	const response = /^\x1b\](10|11|4;\d{1,3});([^\x07\x1b]*)(?:\x07|\x1b\\)$/i.exec(data);
	if (!response) return undefined;
	const target =
		response[1] === "10" ? "foreground" : response[1] === "11" ? "background" : Number(response[1].slice(2));
	return { target, rgb: parseRgb(response[2]) };
}

export function parseTerminalColorSchemeReport(data: string): TerminalColorScheme | undefined {
	const response = /^(?:\x1b\[\?997;(1|2)n)+$/.exec(data);
	return response ? (response[1] === "2" ? "light" : "dark") : undefined;
}
