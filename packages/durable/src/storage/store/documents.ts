import {
	loadContent,
	readDocumentEntry,
	type DocumentAddress as EngineAddress,
	type DocumentEntry,
	type DocumentHistory,
	type DocumentRecord as EngineRecord,
} from "@axi/objects";
import type { SqliteExecutor } from "@axi/objects/sqlite";
import { seqFromNumber } from "../../ids.ts";
import type {
	DocumentAddress,
	DocumentCreate,
	DocumentId,
	DocumentPoint,
	DocumentRecord,
	JsonObject,
	StoredDocument,
} from "../../types.ts";
import { encodeIndexed } from "./tables.ts";

export const SCOPE_NAMESPACES = ["session", "conversation:", "task:"] as const;
export function namespaceOf(scope: DocumentRecord["scope"]): string {
	return scope.kind === "session"
		? "session"
		: scope.kind === "conversation"
			? `conversation:${scope.conversationId}`
			: `task:${scope.taskId}`;
}
export function addressOf(
	address: DocumentAddress | DocumentCreate,
	owner: string,
): EngineAddress {
	return {
		owner,
		namespace: namespaceOf(address.scope),
		kind: encodeIndexed(address.kind),
		...(address.key === undefined ? {} : { key: encodeIndexed(address.key) }),
	};
}
export function historyOf(
	record: DocumentCreate | DocumentRecord,
): DocumentHistory {
	return record.scope.kind === "conversation" && record.history === "rewindable"
		? "rewindable"
		: "latest";
}
export function engineRecord(
	create: DocumentCreate,
	owner: string,
	version: number,
	seq: number,
	retired: boolean,
): EngineRecord {
	return {
		...addressOf(create, owner),
		id: create.id,
		history: historyOf(create),
		createdAt: seq,
		...(retired ? { retiredAt: seq } : {}),
		meta: JSON.stringify({ ...create, createdAt: seq }),
		revision: 1,
		version,
		fingerprint: "",
	};
}
function ownedHere(
	record: { readonly owner: string; readonly namespace: string },
	owner: string,
): boolean {
	return (
		record.owner === owner &&
		(record.namespace === "session" ||
			record.namespace.startsWith("conversation:") ||
			record.namespace.startsWith("task:"))
	);
}
export function durableRecord(
	record: EngineRecord,
	owner: string,
): DocumentRecord | undefined {
	return record.meta === undefined || !ownedHere(record, owner)
		? undefined
		: recordOfEntry({
				meta: record.meta,
				retired_at: record.retiredAt ?? null,
			});
}
export function recordOfEntry(entry: DocumentEntry): DocumentRecord {
	const value = JSON.parse(entry.meta!) as DocumentRecord;
	return entry.retired_at == null
		? value
		: { ...value, retiredAt: seqFromNumber(entry.retired_at) };
}
export function aliveAt(record: DocumentRecord, at: DocumentPoint): boolean {
	return at === "current"
		? record.retiredAt === undefined
		: record.createdAt <= at &&
				(record.retiredAt === undefined || at < record.retiredAt);
}
export type DocumentRead =
	| { readonly kind: "found"; readonly document: StoredDocument | undefined }
	| { readonly kind: "current_only"; readonly id: DocumentId };
export async function readAt(
	executor: Pick<SqliteExecutor, "get" | "all">,
	id: DocumentId,
	at: DocumentPoint,
	owner: string,
): Promise<DocumentRead> {
	const entry = await readDocumentEntry(executor, id);
	if (!entry || entry.meta === null || !ownedHere(entry, owner))
		return { kind: "found", document: undefined };
	const record = recordOfEntry(entry);
	if (at !== "current" && entry.history !== "rewindable")
		return { kind: "current_only", id };
	if (!aliveAt(record, at)) return { kind: "found", document: undefined };
	const content = await loadContent(executor, id, at);
	return {
		kind: "found",
		document: {
			record,
			version: content.version,
			value: content.value as JsonObject,
			deltasSinceBase: content.deltasSinceBase,
		},
	};
}
