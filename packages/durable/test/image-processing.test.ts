import { expect, test } from "vitest";
import { PhotonImage } from "@silvia-odwyer/photon/photon_rs.js";
import { createNodePhotonImages } from "../src/images/node.ts";

const palette = [
	[255, 0, 0],
	[0, 255, 0],
	[0, 0, 255],
	[255, 255, 255],
];
const names = ["red", "green", "blue", "white"];
function fixture(): PhotonImage {
	const width = 24,
		height = 16,
		pixels = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y++)
		for (let x = 0; x < width; x++) {
			const color = palette[(y < height / 2 ? 0 : 2) + (x < width / 2 ? 0 : 1)];
			pixels.set([...color, 255], (y * width + x) * 4);
		}
	return new PhotonImage(pixels, width, height);
}
function corners(image: PhotonImage): string[] {
	const width = image.get_width(),
		height = image.get_height(),
		pixels = image.get_raw_pixels();
	const xs = [Math.floor(width / 4), width - 1 - Math.floor(width / 4)];
	const ys = [Math.floor(height / 4), height - 1 - Math.floor(height / 4)];
	return ys.flatMap((y) =>
		xs.map((x) => {
			const at = (y * width + x) * 4;
			const distances = palette.map((color) =>
				color.reduce((sum, value, channel) => sum + (value - pixels[at + channel]) ** 2, 0),
			);
			return names[distances.indexOf(Math.min(...distances))];
		}),
	);
}
function oriented(jpeg: Uint8Array, orientation: number, little: boolean): Uint8Array {
	const payload = Buffer.alloc(32);
	payload.write("Exif\0\0", 0, "ascii");
	payload.write(little ? "II" : "MM", 6, "ascii");
	const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
	view.setUint16(8, 42, little);
	view.setUint32(10, 8, little);
	view.setUint16(14, 1, little);
	view.setUint16(16, 0x112, little);
	view.setUint16(18, 3, little);
	view.setUint32(20, 1, little);
	view.setUint16(24, orientation, little);
	const header = Buffer.from([255, 225, 0, payload.length + 2]);
	return Uint8Array.from(Buffer.concat([jpeg.subarray(0, 2), header, payload, jpeg.subarray(2)]));
}

test.each([false, true])("JPEG orientation preserves pixel positions and EXIF byte order (worker=%s)", async (worker) => {
	const processor = await createNodePhotonImages({ worker, idleMs: 0 });
	const source = fixture();
	try {
		const bytes = source.get_bytes_jpeg(95);
		const expected = [
			["red", "green", "blue", "white"],
			["green", "red", "white", "blue"],
			["white", "blue", "green", "red"],
			["blue", "white", "red", "green"],
			["red", "blue", "green", "white"],
			["blue", "red", "white", "green"],
			["white", "green", "blue", "red"],
			["green", "white", "red", "blue"],
		];
		for (const little of [false, true])
			for (let orientation = 1; orientation <= 8; orientation++) {
				const prepared = await processor.prepare(oriented(bytes, orientation, little), "image/jpeg", {
					maxWidth: 100,
					maxHeight: 100,
					maxBytes: 100_000,
				});
				if (!prepared) throw new Error(`Orientation ${orientation} could not be prepared`);
				const decoded = PhotonImage.new_from_byteslice(Buffer.from(prepared.data, "base64"));
				try {
					expect([decoded.get_width(), decoded.get_height()]).toEqual(orientation < 5 ? [24, 16] : [16, 24]);
					expect(corners(decoded)).toEqual(expected[orientation - 1]);
				} finally {
					decoded.free();
				}
			}
	} finally {
		source.free();
	}
});

test.each([false, true])("image preparation respects dimensions and byte limits (worker=%s)", async (worker) => {
	const processor = await createNodePhotonImages({ worker, idleMs: 0 });
	const source = fixture();
	try {
		const bytes = source.get_bytes();
		expect(await processor.prepare(bytes, "image/png", { maxWidth: 24, maxHeight: 16, maxBytes: 100_000 })).toEqual({
			data: Buffer.from(bytes).toString("base64"),
			mimeType: "image/png",
		});
		const resized = await processor.prepare(bytes, "image/png", { maxWidth: 12, maxHeight: 8, maxBytes: 100_000 });
		expect(resized?.resized).toEqual({ from: { width: 24, height: 16 }, to: { width: 12, height: 8 } });
		const converted = await processor.prepare(bytes, "image/x-fixture", {
			maxWidth: 24,
			maxHeight: 16,
			maxBytes: 100_000,
		});
		expect(converted).toMatchObject({ mimeType: "image/png", convertedFrom: "image/x-fixture" });
		expect(await processor.prepare(bytes, "image/png", { maxWidth: 24, maxHeight: 16, maxBytes: 1 })).toBeUndefined();
		expect(
			await processor.prepare(new Uint8Array(), "image/png", { maxWidth: 24, maxHeight: 16, maxBytes: 100_000 }),
		).toBeUndefined();
	} finally {
		source.free();
	}
});

test("concurrent worker requests retain their own image limits and leave input bytes intact", async () => {
	const processor = await createNodePhotonImages({ idleMs: 0 });
	const source = fixture();
	try {
		const bytes = source.get_bytes();
		const original = bytes.slice();
		const sizes = [24, 12, 6];
		const results = await Promise.all([
			...sizes.map((width) =>
				processor.prepare(bytes, "image/png", { maxWidth: width, maxHeight: 100, maxBytes: 100_000 }),
			),
			processor.prepare(new Uint8Array(), "image/png", { maxWidth: 100, maxHeight: 100, maxBytes: 100_000 }),
		]);
		for (const [index, width] of sizes.entries()) {
			const prepared = results[index];
			if (!prepared) throw new Error(`No image for width ${width}`);
			const image = PhotonImage.new_from_byteslice(Buffer.from(prepared.data, "base64"));
			try {
				expect([image.get_width(), image.get_height()]).toEqual([width, Math.round(width * 2 / 3)]);
			} finally {
				image.free();
			}
		}
		expect(results[3]).toBeUndefined();
		expect(bytes).toEqual(original);
	} finally {
		source.free();
	}
});
