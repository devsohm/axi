import { extname } from "node:path";
import type { HttpResponse } from "../http/index.ts";
export type ServedFile = { readonly mime: string; readonly bytes: Uint8Array };
export const JAVASCRIPT = "text/javascript; charset=utf-8",
	CSS = "text/css; charset=utf-8";
export const ASSET_EXTENSIONS = ["svg", "png", "jpg", "jpeg", "gif", "webp", "woff", "woff2", "ttf", "wasm"] as const;
const types: Record<string, string> = {
	js: JAVASCRIPT,
	css: CSS,
	svg: "image/svg+xml",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	woff: "font/woff",
	woff2: "font/woff2",
	ttf: "font/ttf",
	wasm: "application/wasm",
	json: "application/json",
};
export function mimeOf(path: string): string {
	return types[extname(path).slice(1).toLowerCase()] ?? "application/octet-stream";
}
export function served(file: ServedFile | undefined): HttpResponse {
	return file
		? {
				kind: "bytes",
				mime: file.mime,
				size: file.bytes.length,
				read: async (offset, length) => file.bytes.subarray(offset, offset + length),
				headers: { "Cache-Control": "private, max-age=31536000, immutable" },
			}
		: { kind: "error", status: 404 };
}
