import type { SqliteExecutor } from "@axi/objects/sqlite";
import type * as T from "../../types.ts";
import { addressValues, claim, currentOnly, decode, encode, type Action, type Cell, type Table } from "./rows.ts";
import type { SqliteSchema } from "./schema.ts";
import { deleteRows, insertRows, readRows } from "./statements.ts";

export class CommitState {
	readonly ids = new Map<number, Table>();
	readonly documents = new Map<number, T.DocumentRecord>();
	readonly versions = new Map<number, number>();
	readonly addresses = new Map<string, number>();
	static async load(
		db: SqliteExecutor,
		tables: SqliteSchema["tables"],
		batches: readonly (readonly T.StorageWrite[])[],
	): Promise<CommitState> {
		const state = new CommitState();
		const ids = new Set<number>(),
			documents = new Set<number>(),
			versions = new Set<number>();
		const addresses = new Map<string, Cell[]>();
		for (const writes of batches)
			for (const write of writes) {
				const identity = claim(write);
				if (identity) ids.add(identity.id);
				if (write.type === "document.create" || write.type === "document.copy") {
					documents.add(write.record.id);
					const address = addressValues(write.record);
					addresses.set(encode(address), address);
				} else if (write.type === "document.change" || write.type === "document.retire") {
					documents.add(write.id);
					if (write.type === "document.change" && write.content.kind === "delta") versions.add(write.id);
				}
			}
		for (const row of await readRows<{ id: number; record_type: Table }>(
			db,
			`SELECT id,record_type FROM ${tables.recordIds} WHERE id IN (SELECT value FROM json_each(?))`,
			[...ids],
		))
			state.ids.set(row.id, row.record_type);
		for (const row of await readRows<{ record: string }>(
			db,
			`SELECT record FROM ${tables.documents} WHERE id IN (SELECT value FROM json_each(?))`,
			[...documents],
		)) {
			const record = decode<T.DocumentRecord>(row.record);
			state.documents.set(record.id, record);
		}
		for (const row of await readRows<{ document_id: number; version: number | null }>(
			db,
			`SELECT requested.value AS document_id,(SELECT version FROM ${tables.documentRevisions} WHERE document_id = requested.value ORDER BY seq DESC LIMIT 1) AS version FROM json_each(?) AS requested`,
			[...versions],
		)) {
			if (row.version !== null) state.versions.set(row.document_id, row.version);
		}
		type Address = {
			id: number;
			kind: string;
			scope_kind: string;
			owner_id: number;
			family: number;
			key_value: string;
		};
		for (const row of await readRows<Address>(
			db,
			`SELECT document.id,document.kind,document.scope_kind,document.owner_id,document.family,document.key_value FROM json_each(?) AS address JOIN ${tables.documents} AS document ON document.kind = json_extract(address.value,'$[0]') AND document.scope_kind = json_extract(address.value,'$[1]') AND document.owner_id = json_extract(address.value,'$[2]') AND document.family = json_extract(address.value,'$[3]') AND document.key_value = json_extract(address.value,'$[4]') WHERE document.retired_at IS NULL`,
			[...addresses.values()],
		)) {
			state.addresses.set(encode([row.kind, row.scope_kind, row.owner_id, row.family, row.key_value]), row.id);
		}
		return state;
	}
	check(writes: readonly T.StorageWrite[], actions: ReadonlyMap<T.DocumentId, Action>): void {
		const claimed = new Map<number, Table>();
		for (const write of writes) {
			const identity = claim(write);
			if (!identity) continue;
			const { id, table } = identity,
				prior = this.ids.get(id),
				sameBatch = claimed.get(id);
			const immutable = table === "conversation" || table === "entry" || table === "document";
			if (prior !== undefined && (immutable || prior !== table))
				throw new Error(`ID ${id} already belongs to ${prior}`);
			if (sameBatch !== undefined && (immutable || sameBatch !== table))
				throw new Error(`ID ${id} is written ${immutable ? "more than once" : "as two record types"}`);
			claimed.set(id, table);
		}
		const counts = new Map<string, number>();
		for (const [id, action] of actions) {
			if (action.copy && actions.has(action.copy.id))
				throw new Error(`Document copy ${id} source is changed in the copy batch`);
			const existing = this.documents.get(id);
			if (!action.create && !existing) throw new Error(`Unknown document: ${id}`);
			if (action.create && existing) throw new Error(`Document ${id} already exists`);
			if (existing?.retiredAt !== undefined) throw new Error(`Document ${id} is retired`);
			if (action.content?.kind === "delta") {
				const version = this.versions.get(id);
				if (version === undefined) throw new Error(`Document ${id} delta has no base`);
				if (version !== action.content.version) throw new Error(`Document ${id} version transition requires a base`);
			}
			if (!action.create && !action.retire) continue;
			const key = encode(addressValues(action.create ?? existing!));
			let count = counts.get(key) ?? (this.addresses.has(key) ? 1 : 0);
			if (action.retire && existing) count--;
			if (action.create && !action.retire) count++;
			counts.set(key, count);
		}
		if ([...counts.values()].some((count) => count > 1))
			throw new Error("Document address already has a current incarnation");
	}
	adopt(writes: readonly T.StorageWrite[], actions: ReadonlyMap<T.DocumentId, Action>, seq: T.Seq): void {
		for (const write of writes) {
			const identity = claim(write);
			if (identity) this.ids.set(identity.id, identity.table);
		}
		for (const [id, action] of actions) {
			if (action.create || action.retire) {
				const record: T.DocumentRecord = action.create
					? { ...action.create, createdAt: seq, ...(action.retire ? { retiredAt: seq } : {}) }
					: { ...this.documents.get(id)!, retiredAt: seq };
				this.documents.set(id, record);
				const key = encode(addressValues(record));
				if (action.create && !action.retire) this.addresses.set(key, id);
				else if (this.addresses.get(key) === id) this.addresses.delete(key);
			}
			if (action.content) this.versions.set(id, action.content.version);
		}
	}
}

export class PendingRows {
	readonly #ids = new Map<number, Table>();
	readonly #conversations: Cell[][] = [];
	readonly #entries: Cell[][] = [];
	readonly #tasks = new Map<number, Cell[]>();
	readonly #submissions = new Map<number, Cell[]>();
	readonly #documents = new Map<number, T.DocumentRecord>();
	readonly #cleared = new Set<number>();
	readonly #revisions = new Map<number, Cell[][]>();
	add(
		writes: readonly T.StorageWrite[],
		actions: ReadonlyMap<T.DocumentId, Action>,
		seq: T.Seq,
		state: CommitState,
	): void {
		for (const write of writes) {
			const identity = claim(write);
			if (identity) this.#ids.set(identity.id, identity.table);
			if (!("value" in write)) continue;
			const row = write.value;
			switch (write.type) {
				case "conversation":
					this.#conversations.push([
						row.id,
						write.value.owner?.conversationId ?? null,
						write.value.owner?.taskId ?? null,
						encode(row),
					]);
					break;
				case "entry":
					this.#entries.push([row.id, write.value.conversationId, write.value.head ?? null, seq, encode(row)]);
					break;
				case "task":
					this.#tasks.set(row.id, [
						row.id,
						write.value.conversationId,
						encode(write.value.kind),
						write.value.state.status,
						Number(write.value.abortRequested),
						Number(write.value.background),
						encode(row),
					]);
					break;
				case "submission":
					this.#submissions.set(row.id, [
						row.id,
						write.value.conversationId,
						write.value.requestId === undefined ? null : encode(write.value.requestId),
						write.value.status,
						encode(row),
					]);
					break;
			}
		}
		for (const [id, action] of actions) {
			const record = state.documents.get(id)!;
			if (action.create || action.retire) this.#documents.set(id, record);
			const clear = () => {
				this.#cleared.add(id);
				this.#revisions.delete(id);
			};
			if (action.content) {
				const content = action.content;
				if (content.kind === "base" && currentOnly(record)) clear();
				const revisions = this.#revisions.get(id) ?? [];
				revisions.push([
					id,
					seq,
					content.kind,
					content.version,
					encode(content.kind === "base" ? content.value : content.ops),
				]);
				this.#revisions.set(id, revisions);
			}
			if (action.retire && currentOnly(record)) clear();
		}
	}
	async flush(db: SqliteExecutor, tables: SqliteSchema["tables"]): Promise<void> {
		await insertRows(db, tables.recordIds, ["id", "record_type"], [...this.#ids], "ON CONFLICT(id) DO NOTHING");
		await insertRows(
			db,
			tables.conversations,
			["id", "owner_conversation_id", "owner_task_id", "record"],
			this.#conversations,
		);
		await insertRows(db, tables.entries, ["id", "conversation_id", "head", "commit_seq", "record"], this.#entries);
		await insertRows(
			db,
			tables.tasks,
			["id", "conversation_id", "kind", "status", "abort_requested", "background", "record"],
			[...this.#tasks.values()],
			"ON CONFLICT(id) DO UPDATE SET conversation_id = excluded.conversation_id,kind = excluded.kind,status = excluded.status,abort_requested = excluded.abort_requested,background = excluded.background,record = excluded.record",
		);
		await insertRows(
			db,
			tables.submissions,
			["id", "conversation_id", "request_id", "status", "record"],
			[...this.#submissions.values()],
			"ON CONFLICT(id) DO UPDATE SET conversation_id = excluded.conversation_id,request_id = excluded.request_id,status = excluded.status,record = excluded.record",
		);
		const documents: Cell[][] = [...this.#documents.values()].map((record) => {
			const [kind, scope, owner, family, key] = addressValues(record);
			return [record.id, kind, family, key, scope, owner, record.createdAt, record.retiredAt ?? null, encode(record)];
		});
		await insertRows(
			db,
			tables.documents,
			["id", "kind", "family", "key_value", "scope_kind", "owner_id", "created_at", "retired_at", "record"],
			documents,
			"ON CONFLICT(id) DO UPDATE SET retired_at = excluded.retired_at,record = excluded.record",
		);
		await deleteRows(db, tables.documentRevisions, [...this.#cleared]);
		await insertRows(
			db,
			tables.documentRevisions,
			["document_id", "seq", "kind", "version", "content"],
			[...this.#revisions.values()].flat(),
		);
		this.#ids.clear();
		this.#conversations.length = 0;
		this.#entries.length = 0;
		this.#tasks.clear();
		this.#submissions.clear();
		this.#documents.clear();
		this.#cleared.clear();
		this.#revisions.clear();
	}
}
