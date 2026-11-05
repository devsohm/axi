import type { ArchivePart } from "../store/archive.ts";
import { decodeJsonl, encodeJsonl } from "../store/jsonl.ts";
import type { OutboxCommit } from "../store/outbox.ts";
import { decodeLogLine, encodeLogLine, LogFormatError } from "./lines.ts";

export type SyncBody = AsyncIterable<Uint8Array>;

async function* transform(source: SyncBody, codec: CompressionStream | DecompressionStream): SyncBody {
	const iterator = source[Symbol.asyncIterator]();
	const input = new ReadableStream<Uint8Array<ArrayBuffer>>({
		async pull(controller) {
			const next = await iterator.next();
			if (next.done) controller.close();
			else controller.enqueue(new Uint8Array(next.value));
		},
		async cancel() {
			await iterator.return?.();
		},
	});
	const reader = input.pipeThrough(codec).getReader();
	try {
		for (;;) {
			const next = await reader.read();
			if (next.done) return;
			yield next.value;
		}
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

export function encodeBatch(commits: Iterable<OutboxCommit> | AsyncIterable<OutboxCommit>): SyncBody {
	async function* chunks() {
		let text = "";
		const encoder = new TextEncoder();
		for await (const commit of commits) {
			text += encodeLogLine(commit);
			if (text.length >= 65_536) {
				yield encoder.encode(text);
				text = "";
			}
		}
		if (text) yield encoder.encode(text);
	}
	return transform(chunks(), new CompressionStream("gzip"));
}
export async function* decodeBatch(body: SyncBody): AsyncGenerator<OutboxCommit> {
	for await (const line of decodeBatchLines(body)) yield line.commit;
}
export async function* decodeBatchLines(
	body: SyncBody,
): AsyncGenerator<{ readonly commit: OutboxCommit; readonly bytes: number }> {
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let text = "",
		number = 0,
		sequence = 0;
	const decode = (bytes?: Uint8Array) => {
		try {
			return bytes === undefined ? decoder.decode() : decoder.decode(bytes, { stream: true });
		} catch (cause) {
			throw new LogFormatError(`Log line ${number + 1} is not UTF-8`, { cause });
		}
	};
	for await (const chunk of transform(body, new DecompressionStream("gzip"))) {
		text += decode(chunk);
		let newline = text.indexOf("\n");
		while (newline !== -1) {
			const line = text.slice(0, newline);
			const commit = decodeLogLine(line, ++number);
			if (commit.seq <= sequence) throw new LogFormatError(`Log line ${number} does not increase the sequence`);
			sequence = commit.seq;
			yield { commit, bytes: line.length + 1 };
			text = text.slice(newline + 1);
			newline = text.indexOf("\n");
		}
	}
	text += decode();
	if (text) throw new LogFormatError(`The body ends inside log line ${number + 1}`);
}
export function encodeSnapshot(parts: AsyncIterable<ArchivePart>): SyncBody {
	return transform(encodeJsonl(parts), new CompressionStream("gzip"));
}
export function decodeSnapshot(body: SyncBody): AsyncIterable<unknown> {
	return decodeJsonl(transform(body, new DecompressionStream("gzip")));
}
