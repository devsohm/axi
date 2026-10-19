export type ImageLimits = { readonly maxWidth: number; readonly maxHeight: number; readonly maxBytes: number };
export const DEFAULT_IMAGE_LIMITS: ImageLimits = { maxWidth: 2000, maxHeight: 2000, maxBytes: 4.5 * 1024 * 1024 };
export type PreparedImage = {
	readonly data: string;
	readonly mimeType: string;
	readonly resized?: {
		readonly from: { readonly width: number; readonly height: number };
		readonly to: { readonly width: number; readonly height: number };
	};
	readonly convertedFrom?: string;
};
export type ImageProcessor = {
	prepare(bytes: Uint8Array, mimeType: string, limits: ImageLimits): Promise<PreparedImage | undefined>;
};
export const INLINE_IMAGE_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export const base64Length = (size: number): number => Math.ceil(size / 3) * 4;
export function toBase64(bytes: Uint8Array): string {
	const chunks: string[] = [];
	for (let offset = 0; offset < bytes.length; offset += 8192)
		chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
	return btoa(chunks.join(""));
}
