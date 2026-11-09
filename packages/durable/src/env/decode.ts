export function rangeDecoder(): TextDecoder {
	return new TextDecoder("utf-8", { ignoreBOM: true });
}
export function startsWithBom(bytes: Uint8Array): boolean {
	return bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191;
}
export class StreamDecoder {
	readonly #decoder = rangeDecoder();
	#atStart = true;
	decode(bytes?: Uint8Array): string {
		let result = bytes === undefined ? this.#decoder.decode() : this.#decoder.decode(bytes, { stream: true });
		if (result.length && this.#atStart) {
			this.#atStart = false;
			if (result.charCodeAt(0) === 0xfeff) result = result.substring(1);
		}
		return result;
	}
}
