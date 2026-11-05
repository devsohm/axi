import type { OutboxCommit } from "../store/outbox.ts";

export const LOG_VERSION = 2;
export class LogFormatError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "LogFormatError";
	}
}
export function encodeLogLine(commit: OutboxCommit): string {
	return JSON.stringify({ v: LOG_VERSION, seq: commit.seq, nextId: commit.nextId, writes: commit.writes }) + "\n";
}
export function decodeLogLine(text: string, number: number): OutboxCommit {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (cause) {
		throw new LogFormatError(`Log line ${number} is not JSON`, { cause });
	}
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new LogFormatError(`Log line ${number} is not an object`);
	const version = "v" in value ? value.v : undefined;
	if (version !== LOG_VERSION) throw new LogFormatError(`Log line ${number} has unknown version ${String(version)}`);
	if (!("seq" in value) || typeof value.seq !== "number" || !Number.isSafeInteger(value.seq) || value.seq < 1)
		throw new LogFormatError(`Log line ${number} has no valid sequence`);
	if (!("nextId" in value) || typeof value.nextId !== "number" || !Number.isSafeInteger(value.nextId))
		throw new LogFormatError(`Log line ${number} has no valid next id`);
	if (!("writes" in value) || !Array.isArray(value.writes))
		throw new LogFormatError(`Log line ${number} has no writes`);
	return { seq: value.seq, nextId: value.nextId, writes: value.writes };
}
