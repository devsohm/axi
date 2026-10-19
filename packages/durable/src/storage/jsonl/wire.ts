import type { JsonValue } from "@axi/chord";
import { seqFromNumber } from "../../ids.ts";
import type {
	DocumentContent,
	DocumentCreate,
	DocumentId,
	Seq,
	StorageWrite,
	TaskId,
	TaskRecord,
} from "../../types.ts";

export type StoredTask = TaskRecord<JsonValue, JsonValue, JsonValue>;
export type MainWrite =
	| Extract<StorageWrite, { type: "conversation" | "entry" | "submission" | "document.retire" }>
	| { readonly type: "task"; readonly value: StoredTask }
	| { readonly type: "task.sidecar"; readonly id: TaskId; readonly ordinal: number }
	| { readonly type: "document.create"; readonly record: DocumentCreate; readonly ordinal: number }
	| { readonly type: "document.change"; readonly id: DocumentId; readonly ordinal: number };
export type Marker = {
	readonly format: 1;
	readonly type: "commit";
	readonly seq: Seq;
	readonly writes: readonly MainWrite[];
};
export type Payload =
	| { readonly type: "task"; readonly value: StoredTask }
	| { readonly type: "document"; readonly id: DocumentId; readonly content: DocumentContent };
export type Sidecar = {
	readonly format: 1;
	readonly type: "record";
	readonly seq: Seq;
	readonly ordinal: number;
	readonly payload: Payload;
};

export class JsonlCorruptionError extends Error {
	constructor(message: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "JsonlCorruptionError";
	}
}
export class JsonlStoragePoisonedError extends Error {
	constructor(cause: Error) {
		super("JSONL storage is poisoned and must be reopened", { cause });
		this.name = "JsonlStoragePoisonedError";
	}
}

export const currentOnly = (document: DocumentCreate): boolean =>
	document.scope.kind !== "conversation" || document.history === "latest";
export const fileName = (kind: "doc" | "task", id: number): string => `${kind}-${id}.jsonl`;
export const recordKey = (file: string, seq: number, ordinal: number): string => JSON.stringify([file, seq, ordinal]);
export const encodeLine = (record: Marker | Sidecar): string => `${JSON.stringify(record)}\n`;
const object = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value);
const ordinal = (value: unknown): boolean => integer(value) && value >= 0;

function decode(text: string, description: string): unknown {
	try {
		return JSON.parse(text);
	} catch (cause) {
		throw new JsonlCorruptionError(`Malformed complete ${description}`, cause instanceof Error ? cause : undefined);
	}
}
function invalid(message: string, description: string): never {
	throw new JsonlCorruptionError(`${message} in ${description}`);
}
function mainWrite(value: unknown, description: string): MainWrite {
	if (!object(value) || typeof value.type !== "string") return invalid("Invalid write", description);
	switch (value.type) {
		case "conversation":
		case "entry":
		case "submission":
			if (!object(value.value) || !integer(value.value.id)) return invalid(`Invalid ${value.type} write`, description);
			break;
		case "task":
			if (
				!object(value.value) ||
				!integer(value.value.id) ||
				!object(value.value.state) ||
				value.value.state.status !== "terminal"
			)
				return invalid("Invalid terminal task write", description);
			break;
		case "document.retire":
			if (!integer(value.id)) return invalid("Invalid document retirement", description);
			break;
		case "task.sidecar":
		case "document.change":
			if (!integer(value.id) || !ordinal(value.ordinal))
				return invalid(
					value.type === "task.sidecar" ? "Invalid task sidecar write" : "Invalid document change",
					description,
				);
			break;
		case "document.create":
			if (!object(value.record) || !integer(value.record.id) || !ordinal(value.ordinal))
				return invalid("Invalid document creation", description);
			break;
		default:
			return invalid("Unknown write type", description);
	}
	return value as MainWrite;
}
export function parseMarker(text: string, line: number): Marker {
	const description = `main.jsonl line ${line}`;
	const value = decode(text, description);
	if (
		!object(value) ||
		value.format !== 1 ||
		value.type !== "commit" ||
		!integer(value.seq) ||
		value.seq < 1 ||
		!Array.isArray(value.writes)
	)
		return invalid("Invalid commit marker", description);
	return {
		format: 1,
		type: "commit",
		seq: seqFromNumber(value.seq),
		writes: value.writes.map((write) => mainWrite(write, description)),
	};
}
export function parseSidecar(text: string, file: string, line: number): Sidecar {
	const description = `${file} line ${line}`;
	const value = decode(text, description);
	if (
		!object(value) ||
		value.format !== 1 ||
		value.type !== "record" ||
		!integer(value.seq) ||
		value.seq < 1 ||
		!ordinal(value.ordinal) ||
		!object(value.payload)
	)
		return invalid("Invalid sidecar record", description);
	const payload = value.payload;
	if (payload.type === "task") {
		if (
			!object(payload.value) ||
			!integer(payload.value.id) ||
			!object(payload.value.state) ||
			payload.value.state.status === "terminal"
		)
			return invalid("Invalid live task record", description);
	} else if (payload.type === "document") {
		if (!integer(payload.id)) return invalid("Invalid document record", description);
		const content = payload.content;
		if (
			!object(content) ||
			!integer(content.version) ||
			content.version < 1 ||
			!((content.kind === "base" && object(content.value)) || (content.kind === "delta" && Array.isArray(content.ops)))
		)
			return invalid("Invalid document content", description);
	} else
		return invalid(
			typeof payload.type === "string" ? "Unknown sidecar record type" : "Invalid sidecar record",
			description,
		);
	return value as Sidecar;
}
