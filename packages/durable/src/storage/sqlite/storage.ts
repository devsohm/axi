import type { Context } from "@axi/objects/context";
import type { JsonValue } from "@axi/objects/json";
import { apply, type Op } from "@axi/objects/delta";
import type { SqliteDatabase, SqliteExecutor, SqliteValue } from "@axi/objects/sqlite";
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
type StoredTask = T.TaskRecord<JsonValue, JsonValue, JsonValue>;
import { addressValues, currentOnly, decode, encode, scopeValues, type Action } from "./rows.ts";
import { CommitState, PendingRows } from "./commit.ts";
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
	async commit(
		batches: readonly (readonly T.StorageWrite[])[],
		receive: (index: number, seq: T.Seq) => void,
		_context: Context,
	): Promise<T.CommitResult> {
		this.#open();
		let nextId = this.#nextId;
		const seqs: T.Seq[] = [];
		let refusal: { error: unknown } | undefined;
		await this.#db.transaction(async (tx) => {
			const metadata = await tx.get<Metadata>(
				`SELECT next_id,next_seq FROM ${this.#schema.tables.durableMetadata} WHERE singleton = 1`,
			);
			if (!metadata) throw new Error("Durable SQLite metadata is missing");
			let next = metadata.next_seq,
				failed = false;
			const check = async <Value>(call: () => Promise<Value>): Promise<Value> => {
				try {
					return await call();
				} catch (error) {
					failed = true;
					throw error;
				}
			};
			const reader: SqliteExecutor = {
				exec: (sql) => check(() => tx.exec(sql)),
				run: (sql, ...params) => check(() => tx.run(sql, ...params)),
				runCounted: (sql, ...params) => check(() => tx.runCounted(sql, ...params)),
				get: <Value extends object>(sql: string, ...params: SqliteValue[]) =>
					check(() => tx.get<Value>(sql, ...params)),
				all: <Value extends object>(sql: string, ...params: SqliteValue[]) =>
					check(() => tx.all<Value>(sql, ...params)),
			};
			const state = await CommitState.load(tx, this.#schema.tables, batches);
			const pending = new PendingRows();
			for (const writes of batches) {
				let actions: Map<T.DocumentId, Action>;
				failed = false;
				try {
					actions = this.#actions(writes);
					state.check(writes, actions);
				} catch (error) {
					refusal = { error };
					break;
				}
				if ([...actions.values()].some((action) => action.copy !== undefined)) {
					await pending.flush(tx, this.#schema.tables);
					try {
						await this.#resolveCopies(reader, actions);
					} catch (error) {
						if (failed) throw error;
						refusal = { error };
						break;
					}
				}
				const seq = seqFromNumber(next++);
				state.adopt(writes, actions, seq);
				pending.add(writes, actions, seq, state);
				seqs.push(seq);
				nextId = Math.max(nextId, this.#nextId);
				for (const write of writes) {
					const id = "value" in write ? write.value.id : "record" in write ? write.record.id : undefined;
					if (id !== undefined) nextId = Math.max(nextId, id + 1);
				}
			}
			await pending.flush(tx, this.#schema.tables);
			if (seqs.length)
				await tx.run(
					`UPDATE ${this.#schema.tables.durableMetadata} SET next_id = ?, next_seq = ? WHERE singleton = 1`,
					String(Math.max(Number(metadata.next_id), nextId)),
					next,
				);
		});
		this.#nextId = Math.max(this.#nextId, nextId);
		for (const [index, seq] of seqs.entries()) receive(index, seq);
		return refusal ? { stored: seqs.length, refused: refusal.error } : { stored: seqs.length };
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
		{ order, after }: ReturnType<typeof scanPosition>,
		limit: number,
		filters: readonly (readonly [string, SqliteValue])[],
	): Promise<T.Page<Value, T.Cursor>> {
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
	async scanConversations(
		query: T.ConversationQuery,
		limit: number,
		cursor: T.Cursor | undefined,
		_context: Context,
	): Promise<T.Page<T.ConversationRecord, T.Cursor>> {
		this.#open();
		const position = scanPosition(query.order, cursor, "ascending");
		const filters: [string, SqliteValue][] = [];
		if (query.ownerConversationId !== undefined) filters.push(["owner_conversation_id", query.ownerConversationId]);
		if (query.ownerTaskId !== undefined) filters.push(["owner_task_id", query.ownerTaskId]);
		return this.#scan(this.#schema.tables.conversations, position, limit, filters);
	}
	async scanTasks(
		query: T.TaskQuery,
		limit: number,
		cursor: T.Cursor | undefined,
		_context: Context,
	): Promise<T.Page<StoredTask, T.Cursor>> {
		this.#open();
		const position = scanPosition(query.order, cursor, "ascending");
		const filters: [string, SqliteValue][] = [];
		if (query.conversationId !== undefined) filters.push(["conversation_id", query.conversationId]);
		if (query.kind !== undefined) filters.push(["kind", encode(query.kind)]);
		if (query.status !== undefined) filters.push(["status", query.status]);
		if (query.abortRequested !== undefined) filters.push(["abort_requested", Number(query.abortRequested)]);
		if (query.background !== undefined) filters.push(["background", Number(query.background)]);
		return this.#scan(this.#schema.tables.tasks, position, limit, filters);
	}
	async scanSubmissions(
		query: T.SubmissionQuery,
		limit: number,
		cursor: T.Cursor | undefined,
		_context: Context,
	): Promise<T.Page<T.SubmissionRecord, T.Cursor>> {
		this.#open();
		const position = scanPosition(query.order, cursor, "ascending");
		const filters: [string, SqliteValue][] = [];
		if (query.conversationId !== undefined) filters.push(["conversation_id", query.conversationId]);
		if (query.status !== undefined) filters.push(["status", query.status]);
		return this.#scan(this.#schema.tables.submissions, position, limit, filters);
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
	async #resolveCopies(tx: SqliteExecutor, actions: Map<T.DocumentId, Action>): Promise<void> {
		for (const [id, action] of actions) {
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
					action.content = { kind: "base", version: stored.version, value: stored.value };
				} catch (cause) {
					throw new Error(`Document copy ${id} was rejected`, { cause });
				}
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
