export type ByteSource = { readonly size: number; read(offset: number, length: number): Promise<Uint8Array> };
const PNG = [137, 80, 78, 71, 13, 10, 26, 10];
const starts = (bytes: Uint8Array, values: readonly number[], at = 0) =>
	values.every((value, index) => bytes[at + index] === value);
const ascii = (bytes: Uint8Array, text: string, at = 0) =>
	[...text].every((char, index) => bytes[at + index] === char.charCodeAt(0));
const u16 = (bytes: Uint8Array, offset: number, little = true): number =>
	little
		? (bytes[offset] ?? 0) + (bytes[offset + 1] ?? 0) * 256
		: (bytes[offset] ?? 0) * 256 + (bytes[offset + 1] ?? 0);
const u32 = (bytes: Uint8Array, offset: number, little = true): number =>
	little
		? u16(bytes, offset) + u16(bytes, offset + 2) * 65536
		: u16(bytes, offset, false) * 65536 + u16(bytes, offset + 2, false);
const pngHeader = (bytes: Uint8Array) => bytes.length >= 16 && u32(bytes, 8, false) === 13 && ascii(bytes, "IHDR", 12);

export function detectSupportedImageMimeType(bytes: Uint8Array): string | undefined {
	if (starts(bytes, [255, 216, 255])) return bytes[3] === 247 ? undefined : "image/jpeg";
	if (starts(bytes, PNG)) {
		if (!pngHeader(bytes)) return undefined;
		for (let at = 8; at + 8 <= bytes.length; ) {
			if (ascii(bytes, "acTL", at + 4)) return undefined;
			if (ascii(bytes, "IDAT", at + 4)) break;
			const next = at + 12 + u32(bytes, at, false);
			if (next <= at || next > bytes.length) break;
			at = next;
		}
		return "image/png";
	}
	if (ascii(bytes, "GIF87a") || ascii(bytes, "GIF89a")) return "image/gif";
	if (ascii(bytes, "RIFF") && ascii(bytes, "WEBP", 8)) return "image/webp";
	if (!ascii(bytes, "BM") || bytes.length < 26) return undefined;
	const size = u32(bytes, 2);
	const pixels = u32(bytes, 10);
	const dib = u32(bytes, 14);
	if ((size !== 0 && size < 26) || pixels < 14 + dib || (size !== 0 && pixels >= size)) return undefined;
	const offset = dib === 12 ? 22 : dib >= 40 && dib <= 124 && bytes.length >= 30 ? 26 : -1;
	return offset >= 0 && u16(bytes, offset) === 1 && [1, 4, 8, 16, 24, 32].includes(u16(bytes, offset + 2))
		? "image/bmp"
		: undefined;
}

export async function detectSupportedImageMimeTypeOf(source: ByteSource): Promise<string | undefined> {
	const header = await source.read(0, 32);
	if (!starts(header, PNG)) return detectSupportedImageMimeType(header);
	if (!pngHeader(header)) return undefined;
	let cache: Uint8Array = new Uint8Array(0);
	let cacheStart = 0;
	for (let at = 8; at + 8 <= source.size; ) {
		if (at < cacheStart || at + 8 > cacheStart + cache.length) {
			cacheStart = at;
			cache = await source.read(at, 65536);
		}
		const chunk = cache.subarray(at - cacheStart, at - cacheStart + 8);
		if (ascii(chunk, "acTL", 4)) return undefined;
		if (ascii(chunk, "IDAT", 4)) break;
		const next = at + 12 + u32(chunk, 0, false);
		if (next <= at || next > source.size) break;
		at = next;
	}
	return "image/png";
}

export function imageDimensions(
	bytes: Uint8Array,
	mimeType: string,
): { readonly width: number; readonly height: number } | undefined {
	switch (mimeType) {
		case "image/png":
			return bytes.length < 24 ? undefined : { width: u32(bytes, 16, false), height: u32(bytes, 20, false) };
		case "image/gif":
			return bytes.length < 10 ? undefined : { width: u16(bytes, 6), height: u16(bytes, 8) };
		case "image/webp": {
			if (bytes.length < 30) return undefined;
			if (ascii(bytes, "VP8 ", 12)) return { width: u16(bytes, 26) & 0x3fff, height: u16(bytes, 28) & 0x3fff };
			if (ascii(bytes, "VP8L", 12)) {
				const packed = u32(bytes, 21);
				return { width: (packed & 0x3fff) + 1, height: ((packed >>> 14) & 0x3fff) + 1 };
			}
			if (ascii(bytes, "VP8X", 12))
				return {
					width: u16(bytes, 24) + (bytes[26] ?? 0) * 65536 + 1,
					height: u16(bytes, 27) + (bytes[29] ?? 0) * 65536 + 1,
				};
			return undefined;
		}
		case "image/jpeg":
			for (let at = 2; at + 9 <= bytes.length; ) {
				if (bytes[at] !== 255) return undefined;
				const marker = bytes[at + 1]!;
				if (marker === 255) {
					at++;
					continue;
				}
				if (marker >= 192 && marker <= 207 && ![196, 200, 204].includes(marker))
					return { width: u16(bytes, at + 7, false), height: u16(bytes, at + 5, false) };
				at += 2 + u16(bytes, at + 2, false);
			}
			return undefined;
		default:
			return undefined;
	}
}
