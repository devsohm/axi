import {
	fliph,
	flipv,
	initSync,
	PhotonImage,
	resize,
	SamplingFilter,
	type SyncInitInput,
} from "@silvia-odwyer/photon/photon_rs.js";
import {
	base64Length,
	INLINE_IMAGE_TYPES,
	type ImageLimits,
	type ImageProcessor,
	type PreparedImage,
	toBase64,
} from "../tools/image-processor.ts";
import { exifOrientation } from "./exif.ts";

function transpose(image: PhotonImage, orientation: number): PhotonImage {
	const width = image.get_width();
	const height = image.get_height();
	const source = image.get_raw_pixels();
	const target = new Uint8Array(source.length);
	for (let index = 0; index < width * height; index++) {
		const x = index % width;
		const y = Math.floor(index / width);
		const outX = orientation === 5 || orientation === 8 ? y : height - y - 1;
		const outY = orientation === 5 || orientation === 6 ? x : width - x - 1;
		target.set(source.subarray(index * 4, index * 4 + 4), (outY * height + outX) * 4);
	}
	image.free();
	return new PhotonImage(target, height, width);
}

function encode(
	image: PhotonImage,
	width: number,
	height: number,
	maxBytes: number,
	jpegFirst: boolean,
): { data: string; mimeType: string } | undefined {
	const resized =
		width === image.get_width() && height === image.get_height()
			? image
			: resize(image, width, height, SamplingFilter.Lanczos3);
	try {
		const encodings = jpegFirst ? [80, 70, 55, 40, 0] : [0, 80, 70, 55, 40];
		for (const quality of encodings) {
			const bytes = quality === 0 ? resized.get_bytes() : resized.get_bytes_jpeg(quality);
			if (base64Length(bytes.length) <= maxBytes)
				return { data: toBase64(bytes), mimeType: quality === 0 ? "image/png" : "image/jpeg" };
		}
		return undefined;
	} finally {
		if (resized !== image) resized.free();
	}
}

function prepare(bytes: Uint8Array, mimeType: string, limits: ImageLimits): PreparedImage | undefined {
	let image: PhotonImage | undefined;
	try {
		const orientation = exifOrientation(bytes);
		image = PhotonImage.new_from_byteslice(bytes);
		if (
			orientation === 1 &&
			INLINE_IMAGE_TYPES.has(mimeType) &&
			image.get_width() <= limits.maxWidth &&
			image.get_height() <= limits.maxHeight &&
			base64Length(bytes.length) <= limits.maxBytes
		)
			return { data: toBase64(bytes), mimeType };
		if (orientation >= 5) {
			const previous = image;
			image = undefined;
			image = transpose(previous, orientation);
		} else {
			if (orientation === 2 || orientation === 3) fliph(image);
			if (orientation === 3 || orientation === 4) flipv(image);
		}
		const from = { width: image.get_width(), height: image.get_height() };
		const scale = Math.min(1, limits.maxWidth / from.width, limits.maxHeight / from.height);
		let width = Math.max(1, Math.round(from.width * scale));
		let height = Math.max(1, Math.round(from.height * scale));
		for (;;) {
			const encoded = encode(image, width, height, limits.maxBytes, mimeType === "image/jpeg");
			if (encoded !== undefined)
				return {
					...encoded,
					...(encoded.mimeType === mimeType ? {} : { convertedFrom: mimeType }),
					...(width === from.width && height === from.height ? {} : { resized: { from, to: { width, height } } }),
				};
			if (width === 1 && height === 1) return undefined;
			width = Math.max(1, Math.floor(width * 0.75));
			height = Math.max(1, Math.floor(height * 0.75));
		}
	} catch {
		return undefined;
	} finally {
		image?.free();
	}
}

export function createPhotonImages(wasm: SyncInitInput): ImageProcessor {
	initSync({ module: wasm });
	return { prepare: async (bytes, mimeType, limits) => prepare(bytes, mimeType, limits) };
}
