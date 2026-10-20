import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

export type ImageProtocol = "kitty" | "iterm2" | null;
export interface TerminalCapabilities {
	images: ImageProtocol;
	trueColor: boolean;
	hyperlinks: boolean;
}
export interface CellDimensions {
	widthPx: number;
	heightPx: number;
}
export interface ImageDimensions {
	widthPx: number;
	heightPx: number;
}
export interface ImageRenderOptions {
	maxWidthCells?: number;
	maxHeightCells?: number;
	preserveAspectRatio?: boolean;
	imageId?: number;
	moveCursor?: boolean;
}
export interface ImageCellSize {
	columns: number;
	rows: number;
}
export interface KittyImageMetadata extends ImageCellSize {
	imageId: number;
	widthPx: number;
	heightPx: number;
}
export interface KittyImagePlacement {
	imageId: number;
	transmissionGeneration: number;
	transmissionBytes: number;
	estimatedDecodedBytes: number;
	rows: number;
	sequence: string;
	replacementLine: string;
}

let capabilities: TerminalCapabilities | undefined;
let overrides: Partial<TerminalCapabilities> = {};
let cells: CellDimensions = { widthPx: 9, heightPx: 18 };
export function getCellDimensions(): CellDimensions {
	return cells;
}
export function setCellDimensions(value: CellDimensions): void {
	cells = value;
}
const bool = (value: string | undefined): boolean | undefined =>
	value === "1" ? true : value === "0" ? false : undefined;
function tmuxLinks(): boolean {
	try {
		return execFileSync("tmux", ["display-message", "-p", "#{client_termfeatures}"], {
			encoding: "utf8",
			timeout: 250,
			stdio: ["ignore", "pipe", "ignore"],
		})
			.split(",")
			.some((value) => value.trim() === "hyperlinks");
	} catch {
		return false;
	}
}
export function detectCapabilities(tmuxForwardsHyperlink: () => boolean = tmuxLinks): TerminalCapabilities {
	const env = process.env,
		program = env.TERM_PROGRAM?.toLowerCase() ?? "",
		term = env.TERM?.toLowerCase() ?? "";
	const hint = /^(truecolor|24bit)$/.test(env.COLORTERM?.toLowerCase() ?? "") || term.endsWith("-direct");
	const links = bool(env.AXI_HYPERLINKS),
		color = bool(env.AXI_TRUE_COLOR);
	let result: TerminalCapabilities = { images: null, trueColor: hint, hyperlinks: false };
	if (env.TMUX || term.startsWith("tmux")) result.hyperlinks = links ?? tmuxForwardsHyperlink();
	else if (!term.startsWith("screen")) {
		if (program === "herdr") result = { images: "kitty", trueColor: hint, hyperlinks: true };
		else if (program === "rex") result = { images: null, trueColor: true, hyperlinks: true };
		else if (
			env.KITTY_WINDOW_ID ||
			program === "kitty" ||
			program === "ghostty" ||
			term.includes("ghostty") ||
			env.GHOSTTY_RESOURCES_DIR ||
			env.WEZTERM_PANE ||
			program === "wezterm" ||
			program === "warpterminal" ||
			env.WARP_SESSION_ID ||
			env.WARP_TERMINAL_SESSION_UUID
		)
			result = { images: "kitty", trueColor: true, hyperlinks: true };
		else if (env.ITERM_SESSION_ID || program === "iterm.app")
			result = { images: "iterm2", trueColor: true, hyperlinks: true };
		else if (env.WT_SESSION || ["alacritty", "vscode", "zed"].includes(program))
			result = { images: null, trueColor: true, hyperlinks: true };
		else if (env.TERMINAL_EMULATOR?.toLowerCase() === "jetbrains-jediterm" || process.platform === "win32")
			result.trueColor = true;
	}
	const image = env.AXI_IMAGE_PROTOCOL?.toLowerCase();
	if (image === "kitty" || image === "iterm2") result.images = image;
	else if (image === "none" || image === "0") result.images = null;
	if (color !== undefined) result.trueColor = color;
	if (links !== undefined) result.hyperlinks = links;
	return result;
}
export function getCapabilities(): TerminalCapabilities {
	return (capabilities ??= {
		...detectCapabilities(overrides.hyperlinks === undefined ? undefined : () => overrides.hyperlinks === true),
		...overrides,
	});
}
export function getTerminalColorMode(value: TerminalCapabilities = getCapabilities()): "truecolor" | "256color" {
	return value.trueColor ? "truecolor" : "256color";
}
export function resetCapabilitiesCache(): void {
	capabilities = undefined;
}
export function setCapabilities(value: TerminalCapabilities): void {
	capabilities = value;
}
export function setCapabilityOverrides(value: Partial<TerminalCapabilities>): void {
	if (
		value.images === overrides.images &&
		value.trueColor === overrides.trueColor &&
		value.hyperlinks === overrides.hyperlinks
	)
		return;
	overrides = { ...value };
	capabilities = undefined;
}
export function isImageLine(text: string): boolean {
	return text.includes("\x1b_G") || text.includes("\x1b]1337;File=");
}
export function allocateImageId(): number {
	return 1 + Math.floor(Math.random() * 0xfffffffe);
}
export function encodeKitty(
	data: string,
	options: { columns?: number; rows?: number; imageId?: number; moveCursor?: boolean } = {},
): string {
	const params = ["a=T", "f=100", "q=2"];
	if (options.moveCursor === false) params.push("C=1");
	if (options.columns) params.push(`c=${options.columns}`);
	if (options.rows) params.push(`r=${options.rows}`);
	if (options.imageId) params.push(`i=${options.imageId}`);
	if (data.length <= 4096) return `\x1b_G${params.join(",")};${data}\x1b\\`;
	let output = "";
	for (let offset = 0; offset < data.length; offset += 4096)
		output += `\x1b_G${offset === 0 ? params.join(",") + "," : ""}m=${offset + 4096 < data.length ? 1 : 0};${data.slice(offset, offset + 4096)}\x1b\\`;
	return output;
}
export function deleteKittyImage(imageId: number): string {
	return `\x1b_Ga=d,d=I,i=${imageId},q=2\x1b\\`;
}
export function deleteAllKittyImages(): string {
	return "\x1b_Ga=d,d=A,q=2\x1b\\";
}
export function deleteAllKittyPlacements(): string {
	return "\x1b_Ga=d,d=a,q=2\x1b\\";
}
export function encodeITerm2(
	data: string,
	options: {
		width?: number | string;
		height?: number | string;
		name?: string;
		preserveAspectRatio?: boolean;
		inline?: boolean;
	} = {},
): string {
	const params = [`inline=${options.inline === false ? 0 : 1}`, `size=${Buffer.byteLength(data, "base64")}`];
	if (options.width !== undefined) params.push(`width=${options.width}`);
	if (options.height !== undefined) params.push(`height=${options.height}`);
	if (options.name) params.push(`name=${Buffer.from(options.name).toString("base64")}`);
	if (options.preserveAspectRatio === false) params.push("preserveAspectRatio=0");
	return `\x1b]1337;File=${params.join(";")}:${data}\x07`;
}

const images = new Map<number, KittyImageMetadata & { transmissionGeneration: number }>();
let generation = 0;
export function registerKittyImageMetadata(metadata: KittyImageMetadata): void {
	images.delete(metadata.imageId);
	images.set(metadata.imageId, { ...metadata, transmissionGeneration: ++generation });
	const oldest = images.keys().next().value;
	if (images.size > 1000 && oldest !== undefined) images.delete(oldest);
}
function metadataFor(controls: string): (KittyImageMetadata & { transmissionGeneration: number }) | undefined {
	const id = /(?:^|,)i=(\d+)(?:,|$)/.exec(controls)?.[1];
	return id === undefined ? undefined : images.get(Number(id));
}
function explicitRows(controls: string): number | undefined {
	const value = Number(/(?:^|,)r=(\d+)(?:,|$)/.exec(controls)?.[1]);
	return value > 0 ? value : undefined;
}
export function getKittyImageMetadata(line: string): KittyImageMetadata | undefined {
	const controls = /\x1b_G([^;]*);/.exec(line)?.[1];
	const entry = controls === undefined ? undefined : metadataFor(controls);
	if (!entry) return undefined;
	const { transmissionGeneration: _generation, ...metadata } = entry;
	return metadata;
}
export function getKittyImagePlacementRows(line: string): number | undefined {
	const controls = /\x1b_G([^;]*);/.exec(line)?.[1];
	return controls === undefined ? undefined : (explicitRows(controls) ?? metadataFor(controls)?.rows);
}
const placementKeys = new Set(["i", "p", "x", "y", "w", "h", "X", "Y", "c", "r", "C", "U", "z", "P", "Q", "H", "V"]);
export function getKittyImagePlacement(line: string): KittyImagePlacement | undefined {
	const header = /\x1b_G([^;]*);/.exec(line);
	if (!header) return undefined;
	const entry = metadataFor(header[1]);
	if (!entry) return undefined;
	let start = header.index,
		controls = header[1],
		end: number;
	while (true) {
		const terminator = line.indexOf("\x1b\\", start + 3);
		if (terminator < 0) return undefined;
		end = terminator + 2;
		if (!/(?:^|,)m=1(?:,|$)/.test(controls)) break;
		start = end;
		if (!line.startsWith("\x1b_G", start)) return undefined;
		const separator = line.indexOf(";", start + 3);
		if (separator < 0) return undefined;
		controls = line.slice(start + 3, separator);
	}
	const retained = header[1].split(",").filter((value) => placementKeys.has(value.split("=", 1)[0]));
	const sequence = `\x1b_Ga=p,q=2,${retained.join(",")}\x1b\\`;
	return {
		imageId: entry.imageId,
		transmissionGeneration: entry.transmissionGeneration,
		transmissionBytes: end - header.index,
		estimatedDecodedBytes: entry.widthPx * entry.heightPx * 4,
		rows: explicitRows(header[1]) ?? entry.rows,
		sequence,
		replacementLine: line.slice(0, header.index) + sequence + line.slice(end),
	};
}
export function cropKittyImageLine(line: string, hiddenRows: number, visibleRows: number): string {
	const metadata = getKittyImageMetadata(line),
		header = /\x1b_G([^;]*);/.exec(line);
	if (!metadata || !header || hiddenRows < 0 || hiddenRows >= metadata.rows || visibleRows <= 0) return line;
	const rows = Math.min(visibleRows, metadata.rows - hiddenRows);
	if (hiddenRows === 0 && rows === metadata.rows) return line;
	const y = Math.floor((metadata.heightPx * hiddenRows) / metadata.rows),
		bottom = Math.ceil((metadata.heightPx * (hiddenRows + rows)) / metadata.rows);
	const controls = header[1].split(",").filter((value) => !/^[yhr]=/.test(value));
	controls.push(`y=${y}`, `h=${Math.max(1, Math.min(metadata.heightPx, bottom) - y)}`, `r=${rows}`);
	return (
		line.slice(0, header.index) + "\x1b_G" + controls.join(",") + ";" + line.slice(header.index + header[0].length)
	);
}

export function calculateImageCellSize(
	image: ImageDimensions,
	maxWidthCells: number,
	maxHeightCells?: number,
	cell: CellDimensions = { widthPx: 9, heightPx: 18 },
	optimizeAspectRatio = false,
): ImageCellSize {
	const maxWidth = Math.max(1, Math.floor(maxWidthCells)),
		maxHeight = maxHeightCells === undefined ? undefined : Math.max(1, Math.floor(maxHeightCells));
	const width = Math.max(1, image.widthPx),
		height = Math.max(1, image.heightPx);
	const widthScale = (maxWidth * cell.widthPx) / width,
		heightScale = maxHeight === undefined ? widthScale : (maxHeight * cell.heightPx) / height;
	const scale = Math.min(widthScale, heightScale);
	let columns = Math.max(1, Math.min(maxWidth, Math.ceil((width * scale) / cell.widthPx)));
	let rows = Math.max(1, Math.ceil((height * scale) / cell.heightPx));
	if (maxHeight !== undefined) rows = Math.min(maxHeight, rows);
	const nearest = (upper: number, ideal: number): number =>
		upper > 1 && Math.max((upper - 1) / ideal, ideal / (upper - 1)) < Math.max(upper / ideal, ideal / upper)
			? upper - 1
			: upper;
	if (optimizeAspectRatio) {
		if (widthScale <= heightScale) rows = nearest(rows, (columns * cell.widthPx * height) / (width * cell.heightPx));
		else columns = nearest(columns, (rows * cell.heightPx * width) / (height * cell.widthPx));
	}
	return { columns, rows };
}
export function calculateImageRows(
	image: ImageDimensions,
	width: number,
	cell: CellDimensions = { widthPx: 9, heightPx: 18 },
): number {
	return calculateImageCellSize(image, width, undefined, cell).rows;
}
export function getPngDimensions(data: string): ImageDimensions | null {
	const bytes = Buffer.from(data, "base64");
	return bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
		? { widthPx: bytes.readUInt32BE(16), heightPx: bytes.readUInt32BE(20) }
		: null;
}
export function getGifDimensions(data: string): ImageDimensions | null {
	const bytes = Buffer.from(data, "base64");
	return bytes.length >= 10 && ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))
		? { widthPx: bytes.readUInt16LE(6), heightPx: bytes.readUInt16LE(8) }
		: null;
}
export function getJpegDimensions(data: string): ImageDimensions | null {
	const bytes = Buffer.from(data, "base64");
	if (bytes.length < 2 || bytes[0] !== 255 || bytes[1] !== 216) return null;
	let offset = 2;
	while (offset < bytes.length - 9) {
		if (bytes[offset] !== 255) {
			offset++;
			continue;
		}
		if (bytes[offset + 1] >= 0xc0 && bytes[offset + 1] <= 0xc2)
			return { widthPx: bytes.readUInt16BE(offset + 7), heightPx: bytes.readUInt16BE(offset + 5) };
		const length = bytes.readUInt16BE(offset + 2);
		if (length < 2) return null;
		offset += length + 2;
	}
	return null;
}
export function getWebpDimensions(data: string): ImageDimensions | null {
	const bytes = Buffer.from(data, "base64");
	if (
		bytes.length < 30 ||
		bytes.subarray(0, 4).toString("ascii") !== "RIFF" ||
		bytes.subarray(8, 12).toString("ascii") !== "WEBP"
	)
		return null;
	switch (bytes.subarray(12, 16).toString("ascii")) {
		case "VP8 ":
			return { widthPx: bytes.readUInt16LE(26) & 0x3fff, heightPx: bytes.readUInt16LE(28) & 0x3fff };
		case "VP8L": {
			const value = bytes.readUInt32LE(21);
			return { widthPx: (value & 0x3fff) + 1, heightPx: ((value >> 14) & 0x3fff) + 1 };
		}
		case "VP8X":
			return { widthPx: bytes.readUIntLE(24, 3) + 1, heightPx: bytes.readUIntLE(27, 3) + 1 };
		default:
			return null;
	}
}
export function getImageDimensions(data: string, mimeType: string): ImageDimensions | null {
	switch (mimeType) {
		case "image/png":
			return getPngDimensions(data);
		case "image/jpeg":
			return getJpegDimensions(data);
		case "image/gif":
			return getGifDimensions(data);
		case "image/webp":
			return getWebpDimensions(data);
		default:
			return null;
	}
}
export function renderImage(
	data: string,
	image: ImageDimensions,
	options: ImageRenderOptions = {},
): { sequence: string; columns: number; rows: number; imageId?: number } | null {
	const protocol = getCapabilities().images;
	if (!protocol) return null;
	const size = calculateImageCellSize(
		image,
		options.maxWidthCells ?? 80,
		options.maxHeightCells,
		getCellDimensions(),
		protocol === "kitty",
	);
	if (protocol === "iterm2")
		return {
			...size,
			sequence: encodeITerm2(data, {
				width: size.columns,
				height: "auto",
				preserveAspectRatio: options.preserveAspectRatio ?? true,
			}),
		};
	if (options.imageId !== undefined) registerKittyImageMetadata({ ...size, ...image, imageId: options.imageId });
	return {
		...size,
		imageId: options.imageId,
		sequence: encodeKitty(data, { ...size, imageId: options.imageId, moveCursor: options.moveCursor }),
	};
}
export function hyperlink(text: string, url: string): string {
	return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}
export function imageFallback(mimeType: string, dimensions?: ImageDimensions, filename?: string): string {
	const pieces: string[] = [];
	if (filename) {
		const home = homedir();
		const label =
			home && (filename === home || filename.startsWith(home + "/") || filename.startsWith(home + "\\"))
				? "~" + filename.slice(home.length)
				: filename;
		pieces.push(
			getCapabilities().hyperlinks && isAbsolute(filename) ? hyperlink(label, pathToFileURL(filename).href) : label,
		);
	}
	pieces.push(`[${mimeType}]`);
	if (dimensions) pieces.push(`${dimensions.widthPx}x${dimensions.heightPx}`);
	return `[Image: ${pieces.join(" ")}]`;
}
