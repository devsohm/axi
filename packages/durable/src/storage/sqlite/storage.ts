import type { Context, JsonValue } from "@axi/chord";
import { apply, type Op } from "@axi/chord/delta";
import type { SqliteDatabase, SqliteExecutor, SqliteValue } from "@axi/chord/sqlite";
import { StorageRequestError } from "../../errors.ts";
import { idFromNumber, seqFromNumber } from "../../ids.ts";
import type * as T from "../../types.ts";
import { scanPosition } from "../rows.ts";
import { applySqliteMigrationsForSchema } from "./migrations.ts";
import { createSqliteSchema, type SqliteSchema } from "./schema.ts";
export type SqliteStorageOptions = { readonly prefix?: string };
type Row = { record: string };
type Revision = { seq: number; kind: "base" | "delta"; version: number; content: string };
type Metadata = { next_id: string; next_seq: number };
type Table = "conversation" | "entry" | "task" | "submission" | "document";
type StoredTask = T.TaskRecord<JsonValue, JsonValue, JsonValue>;
type Action = { create?: T.DocumentCreate; copy?: T.DocumentCopySource; content?: T.DocumentContent; retire: boolean };
const encode = JSON.stringify;
function decode<Value>(text: string): Value {
	return JSON.parse(text) as Value;
}
function scopeValues(scope: T.DocumentRecord["scope"]): readonly [string, number] {
	return [
		scope.kind,
		scope.kind === "session" ? 0 : scope.kind === "conversation" ? scope.conversationId : scope.taskId,
	];
}
function addressValues(address: T.DocumentAddress): SqliteValue[] {
	return [
		encode(address.kind),
		...scopeValues(address.scope),
		address.key === undefined ? 0 : 1,
		encode(address.key ?? ""),
	];
}
const currentOnly = (record: T.DocumentRecord): boolean =>
	record.scope.kind !== "conversation" || record.history === "latest";
function alive(record: T.DocumentRecord, point: T.DocumentPoint): boolean {
	return point === "current"
		? record.retiredAt === undefined
		: record.createdAt <= point && (record.retiredAt === undefined || record.retiredAt > point);
}
function page<Value extends { readonly id: number }>(
	values: Value[],
	limit: number,
	order: T.ScanOrder,
): T.Page<Value, T.Cursor> {
	const items = values.slice(0, limit);
	return values.length > limit ? { items, next: { after: items.at(-1)!.id, order } } : { items };
}
const addressWhere = "kind = ? AND scope_kind = ? AND owner_id = ? AND family = ? AND key_value = ?";
export class SqliteStorage implements T.Storage {
	readonly #db: SqliteDatabase;
	readonly #schema: SqliteSchema;
	#nextId: number;
	#closed = false;
	#closing: Promise<void> | undefined;
	#reads = 0;
	#drained: (() => void) | undefined;
	private constructor(db: SqliteDatabase, schema: SqliteSchema, nextId: number) {
		this.#db = db;
		this.#schema = schema;
		this.#nextId = nextId;
	}
	static async open(db: SqliteDatabase, options: SqliteStorageOptions = {}): Promise<SqliteStorage> {
		try {
			const schema = createSqliteSchema(options.prefix);
			await applySqliteMigrationsForSchema(db, schema);
			const metadata = await db.get<Metadata>(
				`SELECT next_id,next_seq FROM ${schema.tables.durableMetadata} WHERE singleton = 1`,
			);
			if (!metadata) throw new Error("Durable SQLite metadata is missing");
			return new SqliteStorage(db, schema, Number(metadata.next_id));
		} catch (error) {
			try {
				await db.close();
			} catch {}
			throw error;
		}
	}
	#open(): void {
		if (this.#closed) throw new Error("SqliteStorage is closed");
	}
	async mintId<RecordId extends T.Id<string>>(): Promise<RecordId> {
		this.#open();
		if (!Number.isSafeInteger(this.#nextId)) throw new Error("ID space is exhausted");
		return idFromNumber<RecordId>(this.#nextId++);
	}
	async commit(writes: readonly T.StorageWrite[], adopt: (seq: T.Seq) => void, _context: Context): Promise<T.Seq> {
		this.#open();
		const actions = this.#actions(writes);
		let nextId = this.#nextId;
		for (const write of writes) {
			const id = "value" in write ? write.value.id : "record" in write ? write.record.id : undefined;
			if (id !== undefined) nextId = Math.max(nextId, id + 1);
		}
		const seq = await this.#db.transaction(async (tx) => {
			const metadata = await tx.get<Metadata>(
				`SELECT next_id,next_seq FROM ${this.#schema.tables.durableMetadata} WHERE singleton = 1`,
			);
			if (!metadata) throw new Error("Durable SQLite metadata is missing");
			const seq = seqFromNumber(metadata.next_seq);
			await this.#validateIds(tx, writes);
			await this.#validateDocuments(tx, actions);
			for (const write of writes) await this.#writeRecord(tx, write, seq);
			await this.#writeDocuments(tx, actions, seq);
			await tx.run(
				`UPDATE ${this.#schema.tables.durableMetadata} SET next_id = ?, next_seq = ? WHERE singleton = 1`,
				String(Math.max(Number(metadata.next_id), nextId)),
				seq + 1,
			);
			return seq;
		});
		this.#nextId = Math.max(this.#nextId, nextId);
		adopt(seq);
		return seq;
	}
	async #record<Value>(db: SqliteExecutor, table: string, id: number): Promise<Value | undefined> {
		const row = await db.get<Row>(`SELECT record FROM ${table} WHERE id = ?`, id);
		return row ? decode<Value>(row.record) : undefined;
	}
	async conversation(id: T.ConversationId, _context: Context): Promise<T.ConversationRecord | undefined> {
		this.#open();
		return this.#conversation(id);
	}
	#conversation(id: T.ConversationId): Promise<T.ConversationRecord | undefined> {
		return this.#record(this.#db, this.#schema.tables.conversations, id);
	}
	async task(id: T.TaskId, _context: Context): Promise<StoredTask | undefined> {
		this.#open();
		return this.#record(this.#db, this.#schema.tables.tasks, id);
	}
	async submission(id: T.SubmissionId, _context: Context): Promise<T.SubmissionRecord | undefined> {
		this.#open();
		return this.#record(this.#db, this.#schema.tables.submissions, id);
	}
	async #scan<Value extends { readonly id: number }>(
		table: string,
		requested: T.ScanOrder | undefined,
		limit: number,
		cursor: T.Cursor | undefined,
		filters: readonly (readonly [string, SqliteValue])[],
	): Promise<T.Page<Value, T.Cursor>> {
		this.#open();
		const { order, after } = scanPosition(requested, cursor, "ascending");
		const conditions = [`id ${order === "ascending" ? ">" : "<"} ?`, ...filters.map(([column]) => `${column} = ?`)];
		const values: SqliteValue[] = [
			after ?? (order === "ascending" ? -1 : Number.MAX_SAFE_INTEGER),
			...filters.map(([, value]) => value),
			limit + 1,
		];
		const rows = await this.#db.all<Row>(
			`SELECT record FROM ${table} WHERE ${conditions.join(" AND ")} ORDER BY id ${order === "ascending" ? "ASC" : "DESC"} LIMIT ?`,
			...values,
		);
		return page(
			rows.map((row) => decode<Value>(row.record)),
			limit,
			order,
		);
	}
	scanConversations(
		query: T.ConversationQuery,
		limit: number,
		cursor: T.Cursor | undefined,
		_context: Context,
	): Promise<T.Page<T.ConversationRecord, T.Cursor>> {
		const filters: [string, SqliteValue][] = [];
		if (query.ownerConversationId !== undefined) filters.push(["owner_conversation_id", query.ownerConversationId]);
		if (query.ownerTaskId !== undefined) filters.push(["owner_task_id", query.ownerTaskId]);
		return this.#scan(this.#schema.tables.conversations, query.order, limit, cursor, filters);
	}
	scanTasks(
		query: T.TaskQuery,
		limit: number,
		cursor: T.Cursor | undefined,
		_context: Context,
	): Promise<T.Page<StoredTask, T.Cursor>> {
		const filters: [string, SqliteValue][] = [];
		if (query.conversationId !== undefined) filters.push(["conversation_id", query.conversationId]);
		if (query.kind !== undefined) filters.push(["kind", encode(query.kind)]);
		if (query.status !== undefined) filters.push(["status", query.status]);
		if (query.abortRequested !== undefined) filters.push(["abort_requested", Number(query.abortRequested)]);
		if (query.background !== undefined) filters.push(["background", Number(query.background)]);
		return this.#scan(this.#schema.tables.tasks, query.order, limit, cursor, filters);
	}
	scanSubmissions(
		query: T.SubmissionQuery,
		limit: number,
		cursor: T.Cursor | undefined,
		_context: Context,
	): Promise<T.Page<T.SubmissionRecord, T.Cursor>> {
		const filters: [string, SqliteValue][] = [];
		if (query.conversationId !== undefined) filters.push(["conversation_id", query.conversationId]);
		if (query.status !== undefined) filters.push(["status", query.status]);
		return this.#scan(this.#schema.tables.submissions, query.order, limit, cursor, filters);
	}
	async submissionByRequest(
		conversationId: T.ConversationId,
		requestId: string,
		_context: Context,
	): Promise<T.SubmissionRecord | undefined> {
		this.#open();
		const row = await this.#db.get<Row>(
			`SELECT record FROM ${this.#schema.tables.submissions} WHERE conversation_id = ? AND request_id = ?`,
			conversationId,
			encode(requestId),
		);
		return row ? decode<T.SubmissionRecord>(row.record) : undefined;
	}
	entry(
		id: T.EntryId,
		context: Context,
	): Promise<{ readonly entry: T.EntryRecord; readonly commitSeq: T.Seq } | undefined>;
	entry(
		conversationId: T.ConversationId,
		id: T.EntryId,
		context: Context,
	): Promise<{ readonly entry: T.EntryRecord; readonly commitSeq: T.Seq } | undefined>;
	entry(
		first: T.EntryId | T.ConversationId,
		second: T.EntryId | Context,
		third?: Context,
	): Promise<{ readonly entry: T.EntryRecord; readonly commitSeq: T.Seq } | undefined> {
		return this.#admit(async () => {
			const id = third === undefined ? first : typeof second === "number" ? second : undefined;
			if (id === undefined) throw new StorageRequestError("Storage.entry() requires an entry ID");
			let conversation: T.ConversationRecord | undefined;
			if (third !== undefined) {
				conversation = await this.#conversation(idFromNumber<T.ConversationId>(first));
				if (!conversation) throw new StorageRequestError(`Unknown conversation: ${first}`);
			}
			const row = await this.#db.get<Row & { commit_seq: number }>(
				`SELECT record,commit_seq FROM ${this.#schema.tables.entries} WHERE id = ?`,
				id,
			);
			if (!row) return undefined;
			const entry = decode<T.EntryRecord>(row.record);
			if (conversation) {
				let upper = Infinity;
				while (conversation.id !== entry.conversationId) {
					if (!conversation.parent) return undefined;
					upper = Math.min(upper, conversation.parent.at);
					conversation = (await this.#conversation(conversation.parent.conversationId))!;
				}
				if (entry.id > upper) return undefined;
			}
			return { entry, commitSeq: seqFromNumber(row.commit_seq) };
		});
	}
	findLatestHeadMarker(
		conversationId: T.ConversationId,
		at: T.EntryId | undefined,
		_context: Context,
	): Promise<(T.EntryRecord & { readonly head: T.EntryId }) | undefined> {
		return this.#admit(async () => {
			let conversation = await this.#conversation(conversationId);
			if (!conversation) throw new StorageRequestError(`Unknown conversation: ${conversationId}`);
			let upper: number | undefined = at;
			for (;;) {
				const row = await this.#db.get<Row>(
					`SELECT record FROM ${this.#schema.tables.entries} WHERE conversation_id = ? AND head IS NOT NULL${upper === undefined ? "" : " AND id <= ?"} ORDER BY id DESC LIMIT 1`,
					conversation.id,
					...(upper === undefined ? [] : [upper]),
				);
				if (row) return decode<T.EntryRecord & { readonly head: T.EntryId }>(row.record);
				if (!conversation.parent) return undefined;
				upper = Math.min(upper ?? Infinity, conversation.parent.at);
				conversation = (await this.#conversation(conversation.parent.conversationId))!;
			}
		});
	}
	scanEntries(
		query: T.EntryQuery,
		limit: number,
		cursor: T.Cursor | undefined,
		_context: Context,
	): Promise<T.Page<T.EntryRecord, T.Cursor>> {
		return this.#admit(async () => {
			const { order, after } = scanPosition(query.order, cursor, "descending");
			const conversation = await this.#conversation(query.conversationId);
			if (!conversation) throw new StorageRequestError(`Unknown conversation: ${query.conversationId}`);
			let upper: number | undefined = query.maxEntryId;
			if (order === "descending" && after !== undefined) upper = Math.min(upper ?? Number.MAX_SAFE_INTEGER, after - 1);
			const ancestors = this.#entrySegments(conversation, upper, query.minEntryId);
			const segments: { id: T.ConversationId; upper: number | undefined }[] = [];
			if (order === "ascending") for await (const segment of ancestors) segments.push(segment);
			const lower =
				order === "ascending" && after !== undefined
					? Math.max(query.minEntryId ?? after + 1, after + 1)
					: query.minEntryId;
			const records: T.EntryRecord[] = [];
			for await (const segment of order === "ascending" ? segments.reverse() : ancestors) {
				const clauses = ["conversation_id = ?"];
				const params: SqliteValue[] = [segment.id];
				if (lower !== undefined) {
					clauses.push("id >= ?");
					params.push(lower);
				}
				if (segment.upper !== undefined) {
					clauses.push("id <= ?");
					params.push(segment.upper);
				}
				params.push(limit + 1 - records.length);
				const rows = await this.#db.all<Row>(
					`SELECT record FROM ${this.#schema.tables.entries} WHERE ${clauses.join(" AND ")} ORDER BY id ${order === "ascending" ? "ASC" : "DESC"} LIMIT ?`,
					...params,
				);
				records.push(...rows.map((row) => decode<T.EntryRecord>(row.record)));
				if (records.length > limit) break;
			}
			return page(records, limit, order);
		});
	}
	async *#entrySegments(conversation: T.ConversationRecord, upper: number | undefined, lower: number | undefined) {
		for (;;) {
			yield { id: conversation.id, upper };
			if (!conversation.parent) return;
			upper = Math.min(upper ?? Infinity, conversation.parent.at);
			if (lower !== undefined && upper < lower) return;
			conversation = (await this.#conversation(conversation.parent.conversationId))!;
		}
	}
	async findDocument(
		address: T.DocumentAddress,
		at: T.DocumentPoint,
		_context: Context,
	): Promise<T.DocumentRecord | undefined> {
		this.#open();
		const params = addressValues(address);
		const aliveWhere =
			at === "current" ? "retired_at IS NULL" : "created_at <= ? AND (retired_at IS NULL OR retired_at > ?)";
		if (at !== "current") params.push(at, at);
		const row = await this.#db.get<Row>(
			`SELECT record FROM ${this.#schema.tables.documents} WHERE ${addressWhere} AND ${aliveWhere} ORDER BY created_at DESC LIMIT 1`,
			...params,
		);
		return row ? decode<T.DocumentRecord>(row.record) : undefined;
	}
	async scanDocuments(
		query: T.DocumentQuery,
		limit: number,
		cursor: T.Cursor | undefined,
		_context: Context,
	): Promise<T.Page<T.DocumentRecord, T.Cursor>> {
		this.#open();
		const after = cursor?.after;
		if (after !== undefined && (typeof after !== "number" || !Number.isSafeInteger(after)))
			throw new StorageRequestError("Invalid storage cursor");
		const clauses = ["scope_kind = ?", "owner_id = ?", "id > ?"];
		const params: SqliteValue[] = [...scopeValues(query.scope), after ?? -1];
		if (query.kind !== undefined) {
			clauses.push("kind = ?");
			params.push(encode(query.kind));
		}
		if (query.at === "current") clauses.push("retired_at IS NULL");
		else {
			clauses.push("created_at <= ?", "(retired_at IS NULL OR retired_at > ?)");
			params.push(query.at, query.at);
		}
		params.push(limit + 1);
		const rows = await this.#db.all<Row>(
			`SELECT record FROM ${this.#schema.tables.documents} WHERE ${clauses.join(" AND ")} ORDER BY id LIMIT ?`,
			...params,
		);
		return page(
			rows.map((row) => decode<T.DocumentRecord>(row.record)),
			limit,
			"ascending",
		);
	}
	async document(id: T.DocumentId, at: T.DocumentPoint, _context: Context): Promise<T.StoredDocument | undefined> {
		this.#open();
		return this.#db.transaction((tx) => this.#materialize(tx, id, at));
	}
	async #materialize(tx: SqliteExecutor, id: T.DocumentId, at: T.DocumentPoint): Promise<T.StoredDocument | undefined> {
		const record = await this.#record<T.DocumentRecord>(tx, this.#schema.tables.documents, id);
		if (!record) return undefined;
		if (at !== "current" && currentOnly(record))
			throw new StorageRequestError(`Document ${id} does not retain historical content`);
		if (!alive(record, at)) return undefined;
		const upper = at === "current" ? Number.MAX_SAFE_INTEGER : at;
		const table = this.#schema.tables.documentRevisions;
		const base = await tx.get<Revision>(
			`SELECT seq,kind,version,content FROM ${table} WHERE document_id = ? AND kind = 'base' AND seq <= ? ORDER BY seq DESC LIMIT 1`,
			id,
			upper,
		);
		if (!base) throw new Error(`Document ${id} is missing a required base`);
		const revisions = await tx.all<Revision>(
			`SELECT seq,kind,version,content FROM ${table} WHERE document_id = ? AND seq > ? AND seq <= ? ORDER BY seq`,
			id,
			base.seq,
			upper,
		);
		let value = decode<T.JsonObject>(base.content);
		for (const revision of revisions) {
			if (revision.kind !== "delta" || revision.version !== base.version)
				throw new Error(`Document ${id} crosses a stored version boundary without a base`);
			value = apply(value, decode<readonly Op[]>(revision.content));
		}
		return { record, version: base.version, value, deltasSinceBase: revisions.length };
	}
	#actions(writes: readonly T.StorageWrite[]): Map<T.DocumentId, Action> {
		const actions = new Map<T.DocumentId, Action>();
		for (const write of writes) {
			if (
				write.type !== "document.create" &&
				write.type !== "document.copy" &&
				write.type !== "document.change" &&
				write.type !== "document.retire"
			)
				continue;
			const id = "record" in write ? write.record.id : write.id;
			let action = actions.get(id);
			if (!action) {
				action = { retire: false };
				actions.set(id, action);
			}
			if (write.type === "document.retire") {
				if (action.retire) throw new Error(`Document ${id} is retired more than once`);
				action.retire = true;
			} else {
				if (action.content || action.copy || action.create)
					throw new Error(`Document ${id} has more than one content command`);
				if (write.type === "document.copy") {
					action.create = write.record;
					action.copy = write.source;
				} else {
					action.content = write.content;
					if (write.type === "document.create") action.create = write.record;
				}
			}
		}
		return actions;
	}
	async #validateIds(tx: SqliteExecutor, writes: readonly T.StorageWrite[]): Promise<void> {
		const claimed = new Map<number, Table>();
		for (const write of writes) {
			if (write.type === "document.change" || write.type === "document.retire") continue;
			const type: Table = "record" in write ? "document" : write.type;
			const id = "record" in write ? write.record.id : write.value.id;
			const existing = (
				await tx.get<{ record_type: Table }>(
					`SELECT record_type FROM ${this.#schema.tables.recordIds} WHERE id = ?`,
					id,
				)
			)?.record_type;
			const previous = claimed.get(id);
			const immutable = type === "conversation" || type === "entry" || type === "document";
			if (existing !== undefined && (immutable || existing !== type))
				throw new Error(`ID ${id} already belongs to ${existing}`);
			if (previous !== undefined && (immutable || previous !== type))
				throw new Error(`ID ${id} is written ${immutable ? "more than once" : "as two record types"}`);
			claimed.set(id, type);
		}
	}
	async #validateDocuments(tx: SqliteExecutor, actions: ReadonlyMap<T.DocumentId, Action>): Promise<void> {
		const counts = new Map<string, number>();
		for (const [id, action] of actions) {
			if (action.copy && actions.has(action.copy.id))
				throw new Error(`Document copy ${id} source is changed in the copy batch`);
			const existing = await this.#record<T.DocumentRecord>(tx, this.#schema.tables.documents, id);
			if (!action.create && !existing) throw new Error(`Unknown document: ${id}`);
			if (action.create && existing) throw new Error(`Document ${id} already exists`);
			if (existing?.retiredAt !== undefined) throw new Error(`Document ${id} is retired`);
			if (action.content?.kind === "delta") {
				const previous = await tx.get<{ version: number }>(
					`SELECT version FROM ${this.#schema.tables.documentRevisions} WHERE document_id = ? ORDER BY seq DESC LIMIT 1`,
					id,
				);
				if (!previous) throw new Error(`Document ${id} delta has no base`);
				if (previous.version !== action.content.version)
					throw new Error(`Document ${id} version transition requires a base`);
			}
			const address = action.create ?? existing!;
			const values = addressValues(address);
			const key = encode(values);
			let count = counts.get(key);
			if (count === undefined) {
				const current = await tx.get<{ id: number }>(
					`SELECT id FROM ${this.#schema.tables.documents} WHERE ${addressWhere} AND retired_at IS NULL LIMIT 1`,
					...values,
				);
				count = current ? 1 : 0;
			}
			if (action.retire && existing) count--;
			if (action.create && !action.retire) count++;
			counts.set(key, count);
		}
		if ([...counts.values()].some((count) => count > 1))
			throw new Error("Document address already has a current incarnation");
	}
	#claim(tx: SqliteExecutor, id: number, type: Table): Promise<void> {
		return tx.run(`INSERT OR IGNORE INTO ${this.#schema.tables.recordIds} (id,record_type) VALUES (?,?)`, id, type);
	}
	async #insert(
		tx: SqliteExecutor,
		table: string,
		columns: readonly string[],
		values: SqliteValue[],
		replace = false,
	): Promise<void> {
		const update = replace
			? ` ON CONFLICT(id) DO UPDATE SET ${columns
					.slice(1)
					.map((column) => `${column} = excluded.${column}`)
					.join(",")}`
			: "";
		await tx.run(
			`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})${update}`,
			...values,
		);
	}
	async #writeRecord(tx: SqliteExecutor, write: T.StorageWrite, seq: T.Seq): Promise<void> {
		if (!("value" in write)) return;
		const row = write.value;
		const tables = this.#schema.tables;
		await this.#claim(tx, row.id, write.type);
		switch (write.type) {
			case "conversation":
				await this.#insert(
					tx,
					tables.conversations,
					["id", "owner_conversation_id", "owner_task_id", "record"],
					[write.value.id, write.value.owner?.conversationId ?? null, write.value.owner?.taskId ?? null, encode(row)],
				);
				break;
			case "entry":
				await this.#insert(
					tx,
					tables.entries,
					["id", "conversation_id", "head", "commit_seq", "record"],
					[write.value.id, write.value.conversationId, write.value.head ?? null, seq, encode(row)],
				);
				break;
			case "task":
				await this.#insert(
					tx,
					tables.tasks,
					["id", "conversation_id", "kind", "status", "abort_requested", "background", "record"],
					[
						write.value.id,
						write.value.conversationId,
						encode(write.value.kind),
						write.value.state.status,
						Number(write.value.abortRequested),
						Number(write.value.background),
						encode(row),
					],
					true,
				);
				break;
			case "submission":
				await this.#insert(
					tx,
					tables.submissions,
					["id", "conversation_id", "request_id", "status", "record"],
					[
						write.value.id,
						write.value.conversationId,
						write.value.requestId === undefined ? null : encode(write.value.requestId),
						write.value.status,
						encode(row),
					],
					true,
				);
				break;
		}
	}
	async #writeDocuments(tx: SqliteExecutor, actions: ReadonlyMap<T.DocumentId, Action>, seq: T.Seq): Promise<void> {
		const tables = this.#schema.tables;
		for (const [id, action] of actions) {
			let content = action.content;
			if (action.copy) {
				try {
					const stored = await this.#materialize(tx, action.copy.id, action.copy.at);
					if (!stored) throw new Error(`Fork source document ${action.copy.id} cannot be read`);
					const create = action.create!;
					if (
						stored.record.scope.kind !== "conversation" ||
						create.scope.kind !== "conversation" ||
						stored.record.kind !== create.kind ||
						stored.record.key !== create.key ||
						stored.record.history !== create.history ||
						stored.record.fork !== create.fork
					)
						throw new Error(`Fork source document ${action.copy.id} does not match the copied record`);
					content = { kind: "base", version: stored.version, value: stored.value };
				} catch (cause) {
					throw new Error(`Document copy ${id} was rejected`, { cause });
				}
			}
			let record: T.DocumentRecord;
			if (action.create) {
				record = { ...action.create, createdAt: seq, ...(action.retire ? { retiredAt: seq } : {}) };
				const [kind, scopeKind, ownerId, family, key] = addressValues(record);
				await this.#claim(tx, id, "document");
				await this.#insert(
					tx,
					tables.documents,
					["id", "kind", "family", "key_value", "scope_kind", "owner_id", "created_at", "retired_at", "record"],
					[id, kind, family, key, scopeKind, ownerId, seq, action.retire ? seq : null, encode(record)],
				);
			} else record = (await this.#record<T.DocumentRecord>(tx, tables.documents, id))!;
			if (content) {
				if (content.kind === "base" && currentOnly(record))
					await tx.run(`DELETE FROM ${tables.documentRevisions} WHERE document_id = ?`, id);
				await tx.run(
					`INSERT INTO ${tables.documentRevisions} (document_id,seq,kind,version,content) VALUES (?,?,?,?,?)`,
					id,
					seq,
					content.kind,
					content.version,
					encode(content.kind === "base" ? content.value : content.ops),
				);
			}
			if (action.retire) {
				if (!action.create) {
					record = { ...record, retiredAt: seq };
					await tx.run(
						`UPDATE ${tables.documents} SET retired_at = ?, record = ? WHERE id = ?`,
						seq,
						encode(record),
						id,
					);
				}
				if (currentOnly(record)) await tx.run(`DELETE FROM ${tables.documentRevisions} WHERE document_id = ?`, id);
			}
		}
	}
	async #admit<Value>(read: () => Promise<Value>): Promise<Value> {
		this.#open();
		this.#reads++;
		try {
			return await read();
		} finally {
			if (--this.#reads === 0) this.#drained?.();
		}
	}
	close(_context: Context): Promise<void> {
		if (!this.#closing) {
			this.#closed = true;
			this.#closing = (async () => {
				if (this.#reads)
					await new Promise<void>((resolve) => {
						this.#drained = resolve;
					});
				await this.#db.close();
			})();
		}
		return this.#closing;
	}
}
