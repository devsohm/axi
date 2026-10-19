import type { BetaRawMessageStreamEvent } from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import { parseJsonWithRepair } from "../utils/json-parse.ts";
const eventTypes = new Set([
	"message_start",
	"message_delta",
	"message_stop",
	"content_block_start",
	"content_block_delta",
	"content_block_stop",
]);
interface Frame {
	event: string | null;
	data: string;
	raw: string[];
}
async function* frames(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<Frame> {
	const reader = body.getReader(),
		decoder = new TextDecoder();
	let buffer = "",
		event: string | null = null;
	let data: string[] = [],
		raw: string[] = [];
	const consume = (line: string): Frame | undefined => {
		if (!line) {
			if (!event && !data.length) return undefined;
			const frame = { event, data: data.join("\n"), raw };
			event = null;
			data = [];
			raw = [];
			return frame;
		}
		raw.push(line);
		if (line.startsWith(":")) return undefined;
		const colon = line.indexOf(":");
		const field = colon < 0 ? line : line.slice(0, colon);
		const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
		if (field === "event") event = value;
		else if (field === "data") data.push(value);
		return undefined;
	};
	try {
		for (;;) {
			if (signal?.aborted) throw new Error("Request was aborted");
			const chunk = await reader.read();
			buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
			for (;;) {
				const match = /\r\n?|\n/.exec(buffer);
				if (!match) break;
				const frame = consume(buffer.slice(0, match.index));
				buffer = buffer.slice(match.index + match[0].length);
				if (frame) yield frame;
			}
			if (chunk.done) break;
		}
		if (buffer) {
			const frame = consume(buffer);
			if (frame) yield frame;
		}
		const final = consume("");
		if (final) yield final;
	} finally {
		reader.releaseLock();
	}
}
export async function* anthropicEvents(
	response: Response,
	signal?: AbortSignal,
): AsyncGenerator<BetaRawMessageStreamEvent> {
	if (!response.body) throw new Error("Attempted to iterate over an Anthropic response with no body");
	let started = false,
		stopped = false;
	for await (const frame of frames(response.body, signal)) {
		if (frame.event === "error") throw new Error(frame.data);
		if (!eventTypes.has(frame.event ?? "")) continue;
		try {
			const parsed = parseJsonWithRepair<BetaRawMessageStreamEvent>(frame.data);
			if (parsed.type === "message_start") started = true;
			else if (parsed.type === "message_stop") stopped = true;
			yield parsed;
		} catch (error) {
			throw new Error(
				`Could not parse Anthropic SSE event ${frame.event}: ${error instanceof Error ? error.message : String(error)}; data=${frame.data}; raw=${frame.raw.join("\\n")}`,
			);
		}
	}
	if (started && !stopped) throw new Error("Anthropic stream ended before message_stop");
}
