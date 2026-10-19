const textAt = (bytes: Uint8Array, offset: number, text: string): boolean =>
	[...text].every((char, index) => bytes[offset + index] === char.charCodeAt(0));
const exif = (bytes: Uint8Array, at: number) => textAt(bytes, at, "Exif\0\0");

function tiffOffset(bytes: Uint8Array): number {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (bytes[0] === 255 && bytes[1] === 216) {
		for (let offset = 2; offset + 4 <= bytes.length; ) {
			if (bytes[offset] !== 255) return -1;
			if (bytes[offset + 1] === 255) {
				offset++;
				continue;
			}
			if (bytes[offset + 1] === 225 && exif(bytes, offset + 4)) return offset + 10;
			offset += 2 + view.getUint16(offset + 2);
		}
	} else if (textAt(bytes, 0, "RIFF") && textAt(bytes, 8, "WEBP")) {
		for (let offset = 12; offset + 8 <= bytes.length; ) {
			if (textAt(bytes, offset, "EXIF")) return offset + (exif(bytes, offset + 8) ? 14 : 8);
			const size = view.getUint32(offset + 4, true);
			offset += 8 + size + (size % 2);
		}
	}
	return -1;
}

export function exifOrientation(bytes: Uint8Array): number {
	const offset = tiffOffset(bytes);
	if (offset < 0 || offset + 8 > bytes.length) return 1;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const little = bytes[offset] === 73 && bytes[offset + 1] === 73;
	const directory = offset + view.getUint32(offset + 4, little);
	if (directory + 2 > bytes.length) return 1;
	const count = view.getUint16(directory, little);
	for (let index = 0; index < count; index++) {
		const entry = directory + 2 + index * 12;
		if (entry + 12 > bytes.length) return 1;
		if (view.getUint16(entry, little) === 0x112) {
			const orientation = view.getUint16(entry + 8, little);
			return orientation >= 1 && orientation <= 8 ? orientation : 1;
		}
	}
	return 1;
}
