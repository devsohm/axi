import {
	allocateImageId,
	getCapabilities,
	getCellDimensions,
	getImageDimensions,
	getPngDimensions,
	imageFallback,
	renderImage,
	type ImageDimensions,
} from "../terminal-image.ts";
import type { Component } from "../tui.ts";
import { truncateToWidth } from "../utils.ts";

export type ImageTranscoder = (base64Data: string, mimeType: string) => string | null;
let transcode: ImageTranscoder | undefined;
const converted = new Map<string, string | null>();
export function setImageTranscoder(transcoder: ImageTranscoder | undefined): void {
	transcode = transcoder;
	converted.clear();
}
function png(data: string, mime: string): string | null {
	if (!transcode) return null;
	const result = converted.get(data) ?? (converted.has(data) ? null : transcode(data, mime));
	converted.delete(data);
	converted.set(data, result);
	const oldest = converted.keys().next().value;
	if (converted.size > 32 && oldest !== undefined) converted.delete(oldest);
	return result;
}
export interface ImageTheme {
	fallbackColor: (text: string) => string;
}
export interface ImageOptions {
	maxWidthCells?: number;
	maxHeightCells?: number;
	filename?: string;
	imageId?: number;
}

export class Image implements Component {
	readonly #data: string;
	readonly #mime: string;
	readonly #theme: ImageTheme;
	readonly #options: ImageOptions;
	readonly #dimensions: ImageDimensions;
	#imageId: number | undefined;
	#png: string | undefined;
	#cache: { width: number; lines: string[] } | undefined;
	constructor(
		base64Data: string,
		mimeType: string,
		theme: ImageTheme,
		options: ImageOptions = {},
		dimensions?: ImageDimensions,
	) {
		this.#data = base64Data;
		this.#mime = mimeType;
		this.#theme = theme;
		this.#options = options;
		this.#imageId = options.imageId;
		this.#dimensions = dimensions ?? getImageDimensions(base64Data, mimeType) ?? { widthPx: 800, heightPx: 600 };
	}
	getImageId(): number | undefined {
		return this.#imageId;
	}
	invalidate(): void {
		this.#cache = undefined;
	}
	render(width: number): string[] {
		if (this.#cache?.width === width) return this.#cache.lines;
		const caps = getCapabilities(),
			cell = getCellDimensions();
		const maxWidth = Math.max(1, Math.min(width - 2, this.#options.maxWidthCells ?? 60));
		const maxHeight = this.#options.maxHeightCells ?? Math.max(1, Math.ceil((maxWidth * cell.widthPx) / cell.heightPx));
		let data: string | null = this.#data,
			dimensions = this.#dimensions;
		if (caps.images === "kitty" && this.#mime !== "image/png") {
			this.#png ??= png(this.#data, this.#mime) ?? undefined;
			data = this.#png ?? null;
			if (data) dimensions = getPngDimensions(data) ?? dimensions;
		}
		if (caps.images === "kitty" && data && this.#imageId === undefined) this.#imageId = allocateImageId();
		const result =
			caps.images && data
				? renderImage(data, dimensions, {
						maxWidthCells: maxWidth,
						maxHeightCells: maxHeight,
						imageId: this.#imageId,
						moveCursor: false,
					})
				: null;
		let lines: string[];
		if (result) {
			if (result.imageId) this.#imageId = result.imageId;
			const blanks = Array.from({ length: result.rows - 1 }, () => "");
			lines =
				caps.images === "kitty"
					? [result.sequence, ...blanks]
					: [...blanks, (result.rows > 1 ? `\x1b[${result.rows - 1}A` : "") + result.sequence];
		} else
			lines = [
				truncateToWidth(
					this.#theme.fallbackColor(imageFallback(this.#mime, this.#dimensions, this.#options.filename)),
					width,
				),
			];
		this.#cache = { width, lines };
		return lines;
	}
}
