import { invalid } from "../data/internal.ts";
import type { ArchivePart } from "./archive.ts";

export async function* encodeJsonl(
	parts: AsyncIterable<ArchivePart>,
): AsyncIterable<Uint8Array> {
	const encoder = new TextEncoder();
	let buffer = "";
	for await (const part of parts) {
		buffer += JSON.stringify(part) + "\n";
		if (buffer.length >= 65_536) {
			yield encoder.encode(buffer);
			buffer = "";
		}
	}
	if (buffer) yield encoder.encode(buffer);
}
export async function* decodeJsonl(
	bytes: AsyncIterable<Uint8Array>,
): AsyncIterable<unknown> {
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let buffer = "",
		number = 0;
	const decode = (chunk?: Uint8Array): string => {
		try {
			return chunk === undefined
				? decoder.decode()
				: decoder.decode(chunk, { stream: true });
		} catch {
			throw invalid("args", `jsonl: line ${number + 1} is not UTF-8`);
		}
	};
	const parse = (line: string): unknown => {
		try {
			return JSON.parse(line);
		} catch {
			throw invalid("args", `jsonl: line ${number} is not JSON`);
		}
	};
	for await (const chunk of bytes) {
		buffer += decode(chunk);
		let consumed = 0,
			newline = buffer.indexOf("\n");
		while (newline !== -1) {
			const line = buffer.substring(consumed, newline);
			number++;
			if (line.trim()) yield parse(line);
			consumed = newline + 1;
			newline = buffer.indexOf("\n", consumed);
		}
		buffer = buffer.substring(consumed);
	}
	buffer += decode();
	number++;
	if (buffer.trim()) yield parse(buffer);
}
