import { apply, type Op } from "../../delta/index.ts";
import type { JsonValue } from "../../json.ts";
import type { SqliteExecutor, SqliteValue } from "../../sqlite/index.ts";
import { TABLES } from "./schema.ts";
import type { StagedWrite, Step } from "./step.ts";

export type DocumentAddress = {
	readonly owner: string;
	readonly namespace: string;
	readonly kind: string;
	readonly key?: string;
};
export type DocumentHistory = "none" | "latest" | "rewindable";
export type DocumentRecord = DocumentAddress & {
	readonly id: number;
	readonly history: DocumentHistory;
	readonly createdAt: number;
	readonly retiredAt?: number;
	readonly meta?: string;
	readonly revision: number;
	readonly version: number;
	readonly fingerprint: string;
};
export type DocumentBase = {
	readonly version: number;
	readonly fingerprint: string;
	readonly value: JsonValue;
};
export type DocumentContent =
	| ({ readonly kind: "base" } & DocumentBase)
	| {
			readonly kind: "delta";
			readonly version: number;
			readonly ops: readonly Op[];
	  };
export type RevisionContent =
	| {
			readonly kind: "base";
			readonly version: number;
			readonly value: JsonValue;
	  }
	| {
			readonly kind: "delta";
			readonly version: number;
			readonly ops: readonly Op[];
	  };
export type DocumentRevision = {
	readonly id: number;
	readonly seq: number;
	readonly content: RevisionContent;
};
export type DocumentWrite =
	| {
			readonly kind: "document.create";
			readonly record: DocumentRecord;
			readonly base?: DocumentBase;
	  }
	| {
			readonly kind: "document.change";
			readonly id: number;
			readonly revision: number;
			readonly content: DocumentContent;
	  }
	| {
			readonly kind: "document.retire";
			readonly id: number;
			readonly revision: number;
	  }
	| ({ readonly kind: "document.revision" } & DocumentRevision);
export type StoredDocument = {
	readonly record: DocumentRecord;
	readonly value: JsonValue;
	readonly version: number;
	readonly deltasSinceBase: number;
};
export type DocumentPoint = number | "current";
export type DocumentScope = {
	readonly owner: string;
	readonly namespace: string;
	readonly kind?: string;
};
export type DocumentEntry = {
	readonly meta: string | null;
	readonly retired_at?: number | null;
};
export type OwnedDocumentEntry = DocumentEntry & {
	readonly owner: string;
	readonly namespace: string;
	readonly history: DocumentHistory;
};

export function createDocument(
	address: DocumentAddress,
	base: DocumentBase,
	text: string,
	created?: (id: number) => void,
): StagedWrite {
	return {
		order: "create",
		async apply(step) {
			const id = step.ids.mint();
			step.created.push(id);
			created?.(id);
			const record: DocumentRecord = {
				id,
				...address,
				history: "none",
				createdAt: step.seq,
				revision: 1,
				version: base.version,
				fingerprint: base.fingerprint,
			};
			await insertDocument(step, record, text);
			return [{ kind: "document.create", record, base }];
		},
	};
}
export async function insertDocument(
	step: Step,
	record: DocumentRecord,
	text: string | undefined,
): Promise<void> {
	await step.run(
		`INSERT INTO ${TABLES.documents} (id, owner, namespace, kind, key, history, created_at, retired_at, meta, revision, version, fingerprint) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		record.id,
		record.owner,
		record.namespace,
		record.kind,
		record.key ?? "",
		record.history,
		record.createdAt,
		record.retiredAt ?? null,
		record.meta ?? null,
		record.revision,
		record.version,
		record.fingerprint,
	);
	if (text !== undefined)
		await insertRevision(
			step,
			record.id,
			record.createdAt,
			"base",
			record.version,
			text,
		);
	if (record.retiredAt !== undefined)
		await dropRetired(step, record.id, record.history);
}
export function insertRevision(
	step: Step,
	id: number,
	seq: number,
	kind: "base" | "delta",
	version: number,
	text: string,
): Promise<void> {
	return step.run(
		`INSERT INTO ${TABLES.revisions} (document_id, seq, kind, version, content) VALUES (?, ?, ?, ?, ?)`,
		id,
		seq,
		kind,
		version,
		text,
	);
}
export function changeDocument(
	id: number,
	revision: number,
	content: DocumentContent,
	text: string,
): StagedWrite {
	return {
		order: "write",
		async apply(step) {
			await writeContent(step, id, "none", revision, content, text);
			return [{ kind: "document.change", id, revision, content }];
		},
	};
}
export async function writeContent(
	step: Step,
	id: number,
	history: DocumentHistory,
	revision: number,
	content: DocumentContent,
	text: string,
): Promise<void> {
	if (revision >= Number.MAX_SAFE_INTEGER)
		throw new Error(`document ${id}: no revision past the safe range`);
	await insertRevision(step, id, step.seq, content.kind, content.version, text);
	let changes: number;
	if (content.kind === "base")
		changes = await step.runCounted(
			`UPDATE ${TABLES.documents} SET revision = revision + 1, version = ?, fingerprint = ? WHERE id = ? AND revision = ? AND retired_at IS NULL`,
			content.version,
			content.fingerprint,
			id,
			revision,
		);
	else
		changes = await step.runCounted(
			`UPDATE ${TABLES.documents} SET revision = revision + 1 WHERE id = ? AND revision = ? AND version = ? AND retired_at IS NULL`,
			id,
			revision,
			content.version,
		);
	if (changes !== 1)
		throw new Error(`document ${id}: not live at revision ${revision}`);
	if (content.kind === "base" && history !== "rewindable")
		await step.run(
			`DELETE FROM ${TABLES.revisions} WHERE document_id = ? AND seq < ?`,
			id,
			step.seq,
		);
}
export function retireDocument(id: number, revision: number): StagedWrite {
	return {
		order: "retire",
		async apply(step) {
			const changes = await step.runCounted(
				`DELETE FROM ${TABLES.documents} WHERE id = ? AND revision = ? AND retired_at IS NULL`,
				id,
				revision,
			);
			if (changes !== 1)
				throw new Error(`document ${id}: not live at revision ${revision}`);
			await step.run(
				`DELETE FROM ${TABLES.revisions} WHERE document_id = ?`,
				id,
			);
			return [{ kind: "document.retire", id, revision }];
		},
	};
}
async function dropRetired(
	step: Step,
	id: number,
	history: DocumentHistory,
): Promise<void> {
	if (history !== "rewindable") {
		if (history === "none")
			await step.run(`DELETE FROM ${TABLES.documents} WHERE id = ?`, id);
		await step.run(`DELETE FROM ${TABLES.revisions} WHERE document_id = ?`, id);
	}
}
export async function retireRecord(
	step: Step,
	record: DocumentRecord,
): Promise<void> {
	if (record.history !== "none")
		await step.run(
			`UPDATE ${TABLES.documents} SET retired_at = ? WHERE id = ?`,
			step.seq,
			record.id,
		);
	await dropRetired(step, record.id, record.history);
}
type RecordRow = Omit<
	DocumentRecord,
	"createdAt" | "retiredAt" | "meta" | "key"
> & {
	readonly created_at: number;
	readonly retired_at: number | null;
	readonly meta: string | null;
	readonly key: string;
};
type RevisionRow = {
	readonly seq: number;
	readonly kind: "base" | "delta";
	readonly version: number;
	readonly content: string;
};
const RECORD_COLUMNS =
	"id, owner, namespace, kind, key, history, created_at, retired_at, meta, revision, version, fingerprint";
function recordOf(row: RecordRow): DocumentRecord {
	const { key, created_at, retired_at, meta, ...fields } = row;
	return {
		...fields,
		...(key ? { key } : {}),
		createdAt: created_at,
		...(retired_at === null ? {} : { retiredAt: retired_at }),
		...(meta === null ? {} : { meta }),
	};
}
export async function readDocument(
	executor: Pick<SqliteExecutor, "get">,
	id: number,
): Promise<DocumentRecord | undefined> {
	const row = await executor.get<RecordRow>(
		`SELECT ${RECORD_COLUMNS} FROM ${TABLES.documents} WHERE id = ?`,
		id,
	);
	return row && recordOf(row);
}
function findQuery(columns: string, historical: boolean): string {
	const filter = historical
		? "created_at <= ? AND (retired_at IS NULL OR retired_at > ?) ORDER BY created_at DESC LIMIT 1"
		: "retired_at IS NULL";
	return `SELECT ${columns} FROM ${TABLES.documents} WHERE owner = ? AND namespace = ? AND kind = ? AND key = ? AND ${filter}`;
}
const findStatements = [
	findQuery(RECORD_COLUMNS, false),
	findQuery(RECORD_COLUMNS, true),
];
const entryStatements = [
	findQuery("meta", false),
	findQuery("meta, retired_at", true),
];
const atParams = (at: DocumentPoint): readonly number[] =>
	at === "current" ? [] : [at, at];
export async function findDocument(
	executor: Pick<SqliteExecutor, "get">,
	address: DocumentAddress,
	at: DocumentPoint = "current",
): Promise<DocumentRecord | undefined> {
	const row = await executor.get<RecordRow>(
		findStatements[at === "current" ? 0 : 1]!,
		address.owner,
		address.namespace,
		address.kind,
		address.key ?? "",
		...atParams(at),
	);
	return row && recordOf(row);
}
export function readDocumentEntry(
	executor: Pick<SqliteExecutor, "get">,
	id: number,
): Promise<OwnedDocumentEntry | undefined> {
	return executor.get<OwnedDocumentEntry>(
		`SELECT meta, retired_at, owner, namespace, history FROM ${TABLES.documents} WHERE id = ?`,
		id,
	);
}
export function findDocumentEntry(
	executor: Pick<SqliteExecutor, "get">,
	address: DocumentAddress,
	at: DocumentPoint,
): Promise<DocumentEntry | undefined> {
	return executor.get<DocumentEntry>(
		entryStatements[at === "current" ? 0 : 1]!,
		address.owner,
		address.namespace,
		address.kind,
		address.key ?? "",
		...atParams(at),
	);
}
export async function loadContent(
	executor: Pick<SqliteExecutor, "all">,
	id: number,
	at: DocumentPoint,
): Promise<Omit<StoredDocument, "record">> {
	const upper = at === "current" ? Number.MAX_SAFE_INTEGER : at;
	const revisions = await executor.all<RevisionRow>(
		`SELECT seq, kind, version, content FROM ${TABLES.revisions} WHERE document_id = ? AND seq <= ? AND seq >= (SELECT max(seq) FROM ${TABLES.revisions} WHERE document_id = ? AND kind = 'base' AND seq <= ?) ORDER BY seq`,
		id,
		upper,
		id,
		upper,
	);
	const base = revisions[0];
	if (!base || base.kind !== "base") throw new Error(`document ${id}: no base`);
	let value = JSON.parse(base.content) as JsonValue;
	for (let i = 1; i < revisions.length; i++) {
		const delta = revisions[i]!;
		if (delta.version !== base.version)
			throw new Error(`document ${id}: a delta crosses a version`);
		value = apply(value, JSON.parse(delta.content) as Op[]);
	}
	return {
		value,
		version: base.version,
		deltasSinceBase: revisions.length - 1,
	};
}
export async function loadDocument(
	executor: Pick<SqliteExecutor, "all">,
	record: DocumentRecord,
	at: DocumentPoint = "current",
): Promise<StoredDocument> {
	return { record, ...(await loadContent(executor, record.id, at)) };
}
export async function listDocumentKeys(
	executor: SqliteExecutor,
	address: Omit<DocumentAddress, "key">,
	after: string | undefined,
	limit: number,
): Promise<string[]> {
	const rows = await executor.all<{ key: string }>(
		`SELECT key FROM ${TABLES.documents} WHERE owner = ? AND namespace = ? AND kind = ?${after === undefined ? "" : " AND key > ?"} AND retired_at IS NULL ORDER BY key LIMIT ?`,
		address.owner,
		address.namespace,
		address.kind,
		...(after === undefined ? [] : [after]),
		limit,
	);
	return rows.map((row) => row.key);
}
function listQuery(
	columns: string,
	scopedKind: boolean,
	historical: boolean,
): string {
	return `SELECT ${columns} FROM ${TABLES.documents} WHERE owner = ? AND namespace = ? AND id > ?${scopedKind ? " AND kind = ?" : ""} AND ${historical ? "created_at <= ? AND (retired_at IS NULL OR retired_at > ?)" : "retired_at IS NULL"} ORDER BY id LIMIT ?`;
}
const listStatements = [false, true].flatMap((history) =>
	[false, true].map((kind) => listQuery(RECORD_COLUMNS, kind, history)),
);
const listEntries = [false, true].flatMap((history) =>
	[false, true].map((kind) =>
		listQuery(history ? "meta, retired_at" : "meta", kind, history),
	),
);
function scanArgs(
	scope: DocumentScope,
	at: DocumentPoint,
	after: number,
	limit: number,
): SqliteValue[] {
	return [
		scope.owner,
		scope.namespace,
		after,
		...(scope.kind === undefined ? [] : [scope.kind]),
		...atParams(at),
		limit,
	];
}
function scanIndex(scope: DocumentScope, at: DocumentPoint): number {
	return (at === "current" ? 0 : 2) + (scope.kind === undefined ? 0 : 1);
}
export async function listDocuments(
	executor: Pick<SqliteExecutor, "all">,
	scope: DocumentScope,
	at: DocumentPoint,
	after: number,
	limit: number,
): Promise<DocumentRecord[]> {
	return (
		await executor.all<RecordRow>(
			listStatements[scanIndex(scope, at)]!,
			...scanArgs(scope, at, after, limit),
		)
	).map(recordOf);
}
export function listDocumentEntries(
	executor: Pick<SqliteExecutor, "all">,
	scope: DocumentScope,
	at: DocumentPoint,
	after: number,
	limit: number,
): Promise<DocumentEntry[]> {
	return executor.all<DocumentEntry>(
		listEntries[scanIndex(scope, at)]!,
		...scanArgs(scope, at, after, limit),
	);
}
export async function listRecords(
	executor: SqliteExecutor,
	after: number,
	limit: number,
): Promise<DocumentRecord[]> {
	return (
		await executor.all<RecordRow>(
			`SELECT ${RECORD_COLUMNS} FROM ${TABLES.documents} WHERE id > ? ORDER BY id LIMIT ?`,
			after,
			limit,
		)
	).map(recordOf);
}
export async function listRevisions(
	executor: SqliteExecutor,
	id: number,
	after: number,
	limit: number,
): Promise<DocumentRevision[]> {
	const rows = await executor.all<RevisionRow>(
		`SELECT seq, kind, version, content FROM ${TABLES.revisions} WHERE document_id = ? AND seq > ? ORDER BY seq LIMIT ?`,
		id,
		after,
		limit,
	);
	return rows.map(({ seq, kind, version, content }) => ({
		id,
		seq,
		content:
			kind === "base"
				? { kind, version, value: JSON.parse(content) as JsonValue }
				: { kind, version, ops: JSON.parse(content) as Op[] },
	}));
}
