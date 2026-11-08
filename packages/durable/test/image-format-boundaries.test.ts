import { expect, test } from "vitest";
import { detectSupportedImageMimeType, detectSupportedImageMimeTypeOf, imageDimensions } from "../src/tools/image.ts";

const encode = (text: string) => new TextEncoder().encode(text);
function png(...chunks: { type: string; length: number }[]): Uint8Array {
	const bytes = new Uint8Array(8 + chunks.reduce((size, chunk) => size + chunk.length + 12, 0));
	bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
	let offset = 8;
	for (const chunk of chunks) {
		new DataView(bytes.buffer).setUint32(offset, chunk.length);
		bytes.set(encode(chunk.type), offset + 4);
		offset += chunk.length + 12;
	}
	return bytes;
}
function bitmap(dib: number, bits = 24, planes = 1): Uint8Array {
	const bytes = new Uint8Array(Math.max(30, dib + 14)),
		view = new DataView(bytes.buffer);
	bytes.set(encode("BM"));
	view.setUint32(2, dib + 100, true);
	view.setUint32(10, dib + 14, true);
	view.setUint32(14, dib, true);
	const offset = dib === 12 ? 22 : 26;
	view.setUint16(offset, planes, true);
	view.setUint16(offset + 2, bits, true);
	return bytes;
}

test("image signatures distinguish supported static formats and reject malformed format headers", () => {
	for (const [bytes, expected] of [
		[new Uint8Array(), undefined],
		[new Uint8Array([255, 216, 255, 224]), "image/jpeg"],
		[new Uint8Array([255, 216, 255, 247]), undefined],
		[encode("GIF87a"), "image/gif"],
		[encode("GIF89a"), "image/gif"],
		[encode("RIFF0000WEBP"), "image/webp"],
		[encode("RIFF0000WAVE"), undefined],
		[png({ type: "IHDR", length: 13 }, { type: "IDAT", length: 0 }), "image/png"],
		[png({ type: "IHDR", length: 12 }), undefined],
		[png({ type: "IHDR", length: 13 }, { type: "acTL", length: 8 }), undefined],
	] as const)
		expect(detectSupportedImageMimeType(bytes)).toBe(expected);
});

test.each([12, 40, 108, 124])(
	"BMP recognition accepts a DIB header of %i bytes only with supported planes and bit depth",
	(dib) => {
		for (const bits of [1, 4, 8, 16, 24, 32]) expect(detectSupportedImageMimeType(bitmap(dib, bits))).toBe("image/bmp");
		expect(detectSupportedImageMimeType(bitmap(dib, 7))).toBeUndefined();
		expect(detectSupportedImageMimeType(bitmap(dib, 24, 2))).toBeUndefined();
	},
);

test("BMP recognition rejects overlapping pixel data, short files and unsupported DIB variants", () => {
	for (const dib of [13, 39, 125]) expect(detectSupportedImageMimeType(bitmap(dib))).toBeUndefined();
	for (const [offset, value] of [
		[2, 25],
		[10, 20],
		[10, 140],
	] as const) {
		const bytes = bitmap(40);
		new DataView(bytes.buffer).setUint32(offset, value, true);
		expect(detectSupportedImageMimeType(bytes)).toBeUndefined();
	}
	const bytes = bitmap(40);
	new DataView(bytes.buffer).setUint32(2, 0, true);
	expect(detectSupportedImageMimeType(bytes)).toBe("image/bmp");
	expect(detectSupportedImageMimeType(bytes.subarray(0, 25))).toBeUndefined();
});

test("streamed PNG recognition skips large metadata chunks and detects animation beyond its first read", async () => {
	for (const animated of [false, true]) {
		const bytes = png(
			{ type: "IHDR", length: 13 },
			{ type: "tEXt", length: 70_000 },
			{ type: animated ? "acTL" : "IDAT", length: 0 },
		);
		const reads: [number, number][] = [];
		const detected = await detectSupportedImageMimeTypeOf({
			size: bytes.length,
			async read(offset, length) {
				reads.push([offset, length]);
				return bytes.slice(offset, offset + length);
			},
		});
		expect(detected).toBe(animated ? undefined : "image/png");
		expect(reads[0]).toEqual([0, 32]);
		expect(reads.some(([offset]) => offset > 65_536)).toBe(true);
		expect(reads.every(([, length]) => length <= 65_536)).toBe(true);
	}
	for (const bytes of [encode("GIF89a"), png({ type: "IHDR", length: 12 })])
		expect(
			await detectSupportedImageMimeTypeOf({
				size: bytes.length,
				read: async (offset, length) => bytes.slice(offset, offset + length),
			}),
		).toBe(detectSupportedImageMimeType(bytes));
});

test("PNG and GIF dimension fields retain their format-specific byte order", () => {
	const bytes = png({ type: "IHDR", length: 13 }),
		view = new DataView(bytes.buffer);
	view.setUint32(16, 513);
	view.setUint32(20, 1027);
	expect(imageDimensions(bytes, "image/png")).toEqual({ width: 513, height: 1027 });
	const gif = new Uint8Array(10);
	gif.set(encode("GIF89a"));
	const gifView = new DataView(gif.buffer);
	gifView.setUint16(6, 513, true);
	gifView.setUint16(8, 1027, true);
	expect(imageDimensions(gif, "image/gif")).toEqual({ width: 513, height: 1027 });
	for (const mime of ["image/png", "image/gif", "image/webp", "image/jpeg", "image/bmp", "unknown"])
		expect(imageDimensions(new Uint8Array(), mime)).toBeUndefined();
});

test.each(["VP8 ", "VP8L", "VP8X"])("WebP %s dimensions decode their packed fields", (kind) => {
	const bytes = new Uint8Array(30),
		view = new DataView(bytes.buffer);
	bytes.set(encode("RIFF"));
	bytes.set(encode("WEBP"), 8);
	bytes.set(encode(kind), 12);
	if (kind === "VP8 ") {
		view.setUint16(26, 0xc201, true);
		view.setUint16(28, 0x4403, true);
	} else if (kind === "VP8L") view.setUint32(21, 512 | (1026 << 14), true);
	else {
		bytes.set([0, 2, 0], 24);
		bytes.set([2, 4, 0], 27);
	}
	expect(imageDimensions(bytes, "image/webp")).toEqual({ width: 513, height: 1027 });
	bytes.set(encode("NONE"), 12);
	expect(imageDimensions(bytes, "image/webp")).toBeUndefined();
});

test("JPEG dimensions skip metadata and padding and reject truncated or non-marker segments", () => {
	for (const padding of [false, true]) {
		const bytes = new Uint8Array(padding ? 18 : 17);
		bytes.set([255, 216, 255, 224, 0, 4, 0, 0], 0);
		let at = 8;
		if (padding) bytes[at++] = 255;
		bytes.set([255, 192, 0, 7, 8, 4, 3, 2, 1], at);
		expect(imageDimensions(bytes, "image/jpeg")).toEqual({ width: 513, height: 1027 });
		bytes[8] = 0;
		expect(imageDimensions(bytes, "image/jpeg")).toBeUndefined();
	}
});
