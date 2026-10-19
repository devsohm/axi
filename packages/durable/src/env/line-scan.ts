import { rangeDecoder } from "./decode.ts";
import type { LineScan } from "./index.ts";

const encoder = new TextEncoder();
export class LineScanner {
	readonly #from: number;
	readonly #to: number;
	readonly #decoder = rangeDecoder();
	#atStart = true;
	#position = 0;
	#newlines = 0;
	#lineStart = 0;
	#decodedLine = 0;
	#start: number | undefined;
	#end: number | undefined;
	#firstLineEnd: number | undefined;
	#lastLineStart: number | undefined;
	#bytes = 0;
	#firstBytes = 0;

	constructor(startLine: number, endLine = Infinity) {
		if (
			!Number.isSafeInteger(startLine) ||
			startLine < 0 ||
			endLine <= startLine ||
			(endLine !== Infinity && !Number.isSafeInteger(endLine))
		)
			throw new RangeError("Invalid line range");
		this.#from = startLine;
		this.#to = endLine;
		this.#decodedLine = startLine;
		if (startLine === 0) this.#start = 0;
	}
	push(bytes: Uint8Array): void {
		for (let index = bytes.indexOf(10); index !== -1; index = bytes.indexOf(10, index + 1)) {
			const offset = this.#position + index;
			if (this.#newlines === this.#from) this.#firstLineEnd = offset;
			if (this.#newlines === this.#to - 1) {
				this.#end = offset;
				this.#lastLineStart = this.#lineStart;
			}
			this.#newlines++;
			this.#lineStart = offset + 1;
			if (this.#newlines === this.#from) this.#start = this.#lineStart;
		}
		const from = Math.max(0, (this.#start ?? this.#position + bytes.length) - this.#position);
		const to = Math.min(bytes.length, (this.#end ?? this.#position + bytes.length) - this.#position);
		if (to > from) this.#count(this.#decoder.decode(bytes.subarray(from, to), { stream: true }));
		this.#position += bytes.length;
	}
	#count(text: string): void {
		if (text !== "" && this.#atStart) {
			this.#atStart = false;
			if (this.#from === 0 && text.charCodeAt(0) === 0xfeff) text = text.slice(1);
		}
		const pieces = text.split("\n");
		for (let index = 0; index < pieces.length; index++) {
			if (this.#decodedLine >= this.#from && this.#decodedLine < this.#to) {
				const size = encoder.encode(pieces[index]).length;
				this.#bytes += size;
				if (this.#decodedLine === this.#from) this.#firstBytes += size;
				if (index < pieces.length - 1 && this.#decodedLine + 1 < this.#to) this.#bytes++;
			}
			if (index < pieces.length - 1) this.#decodedLine++;
		}
	}
	finish(): LineScan {
		this.#count(this.#decoder.decode());
		const absent = this.#start === undefined;
		return {
			newlines: this.#newlines,
			start: this.#start ?? this.#position,
			end: this.#end ?? this.#position,
			firstLineEnd: absent ? this.#position : (this.#firstLineEnd ?? this.#position),
			lastLineStart: absent ? this.#position : (this.#lastLineStart ?? this.#lineStart),
			selectedBytes: this.#bytes,
			firstLineBytes: this.#firstBytes,
		};
	}
}
