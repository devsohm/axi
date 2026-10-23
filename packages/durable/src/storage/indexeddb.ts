/// <reference lib="dom" />
import type { Context, JsonValue } from "@axi/chord";
import { apply, type Op } from "@axi/chord/delta";
import { StorageRequestError } from "../errors.ts";
import { idFromNumber, seqFromNumber } from "../ids.ts";
import type * as T from "../types.ts";
import { scanPosition } from "./rows.ts";

type Task = T.TaskRecord<JsonValue, JsonValue, JsonValue>;
type Table = "conversation" | "entry" | "task" | "submission" | "document";
type RecordRow<R> = { id: number; record: R };
type ConversationRow = RecordRow<T.ConversationRecord> & {
	ownerConversationId?: T.ConversationId;
	ownerTaskId?: T.TaskId;
};
type EntryRow = RecordRow<T.EntryRecord> & {
	conversationId: T.ConversationId;
	headConversationId?: T.ConversationId;
	commitSeq: T.Seq;
};
type TaskRow = RecordRow<Task> & {
	conversationId: T.ConversationId;
	kind: string;
	status: Task["state"]["status"];
	abortRequested: 0 | 1;
	background: 0 | 1;
};
type SubmissionRow = RecordRow<T.SubmissionRecord> & {
	conversationId: T.ConversationId;
	requestId?: string;
	status: T.SubmissionRecord["status"];
};
type DocumentRow = RecordRow<T.DocumentRecord> & {
	kind: string;
	scopeKind: T.DocumentRecord["scope"]["kind"];
	ownerId: number;
	family: 0 | 1;
	keyValue: string;
	createdAt: T.Seq;
	retiredAt?: T.Seq;
};
type Revision = {
	documentId: T.DocumentId;
	seq: T.Seq;
	kind: T.DocumentContent["kind"];
	version: number;
	content: T.JsonObject | readonly Op[];
};
type Metadata = { key: "state"; nextId: number; nextSeq: number };
type Mutation = {
	create?: T.DocumentCreate;
	copy?: Extract<T.StorageWrite, { type: "document.copy" }>["source"];
	content?: T.DocumentContent;
	retire: boolean;
};
const maximum = Number.MAX_SAFE_INTEGER;
const stores = [
	"meta",
	"record_ids",
	"conversations",
	"entries",
	"tasks",
	"submissions",
	"documents",
	"document_revisions",
];
export interface IndexedDbStorageOptions {
	readonly indexedDB?: IDBFactory;
}
function result<Value>(request: IDBRequest<Value>): Promise<Value> {
	return new Promise((resolve, reject) => {
		request.addEventListener("success", () => resolve(request.result), { once: true });
		request.addEventListener("error", () => reject(request.error ?? new Error("IndexedDB request failed")), {
			once: true,
		});
	});
}
function finished(tx: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		tx.addEventListener("complete", () => resolve(), { once: true });
		tx.addEventListener("abort", () => reject(tx.error ?? new Error("IndexedDB transaction was aborted")), {
			once: true,
		});
		tx.addEventListener("error", () => reject(tx.error ?? new Error("IndexedDB transaction failed")), { once: true });
	});
}
function get<Value>(tx: IDBTransaction, store: string, key: IDBValidKey): Promise<Value | undefined> {
	return result(tx.objectStore(store).get(key));
}
function keyRanges(): typeof IDBKeyRange {
	if (typeof IDBKeyRange === "undefined") throw new Error("IndexedDB key ranges are not available");
	return IDBKeyRange;
}
function range(prefix: readonly IDBValidKey[], lower = 0, upper = maximum, lowerOpen = false, upperOpen = false) {
	return keyRanges().bound([...prefix, lower], [...prefix, upper], lowerOpen, upperOpen);
}
function values<Row>(
	source: IDBObjectStore | IDBIndex,
	range: IDBKeyRange | IDBValidKey | null,
	direction: IDBCursorDirection,
	count: number,
	accept: (row: Row) => boolean = () => true,
): Promise<Row[]> {
	return new Promise((resolve, reject) => {
		const request = source.openCursor(range, direction),
			rows: Row[] = [];
		request.addEventListener("error", () => reject(request.error ?? new Error("IndexedDB cursor failed")), {
			once: true,
		});
		request.addEventListener("success", () => {
			const cursor = request.result;
			if (!cursor) {
				resolve(rows);
				return;
			}
			const row: Row = cursor.value;
			if (accept(row)) rows.push(row);
			if (rows.length >= count) resolve(rows);
			else cursor.continue();
		});
	});
}
async function first<Row>(
	source: IDBObjectStore | IDBIndex,
	range: IDBKeyRange | IDBValidKey | null,
	direction: IDBCursorDirection,
	accept?: (row: Row) => boolean,
): Promise<Row | undefined> {
	return (await values(source, range, direction, 1, accept))[0];
}
function page<Row extends { readonly id: number }>(
	rows: readonly Row[],
	limit: number,
	order: T.ScanOrder = "ascending",
): T.Page<Row, T.Cursor> {
	const items = rows.slice(0, limit);
	return rows.length <= limit ? { items } : { items, next: { after: items[items.length - 1].id, order } };
}
function scope(scope: T.DocumentRecord["scope"]) {
	return {
		scopeKind: scope.kind,
		ownerId: scope.kind === "conversation" ? scope.conversationId : scope.kind === "task" ? scope.taskId : 0,
	};
}
function address(record: T.DocumentAddress) {
	return {
		kind: record.kind,
		...scope(record.scope),
		family: record.key === undefined ? (0 as const) : (1 as const),
		keyValue: record.key ?? "",
	};
}
function addressPrefix(record: T.DocumentAddress): IDBValidKey[] {
	const a = address(record);
	return [a.kind, a.scopeKind, a.ownerId, a.family, a.keyValue];
}
function alive(record: T.DocumentRecord, at: T.DocumentPoint) {
	return at === "current"
		? record.retiredAt === undefined
		: record.createdAt <= at && (record.retiredAt === undefined || at < record.retiredAt);
}
function currentOnly(record: T.DocumentRecord) {
	return record.scope.kind !== "conversation" || record.history === "latest";
}
function schema(db: IDBDatabase) {
	db.createObjectStore("meta", { keyPath: "key" }).add({ key: "state", nextId: 2, nextSeq: 1 } satisfies Metadata);
	db.createObjectStore("record_ids", { keyPath: "id" });
	const definitions: Record<string, { keyPath: string | string[]; indexes: Record<string, string[]> }> = {
		conversations: {
			keyPath: "id",
			indexes: {
				conversations_by_owner_conversation: ["ownerConversationId", "id"],
				conversations_by_owner_task: ["ownerTaskId", "id"],
			},
		},
		entries: {
			keyPath: "id",
			indexes: {
				entries_by_conversation: ["conversationId", "id"],
				entry_heads_by_conversation: ["headConversationId", "id"],
			},
		},
		tasks: {
			keyPath: "id",
			indexes: {
				tasks_by_status: ["status", "id"],
				tasks_by_conversation: ["conversationId", "id"],
				tasks_by_kind: ["kind", "id"],
				tasks_by_abort_requested: ["abortRequested", "id"],
				tasks_by_background: ["background", "id"],
			},
		},
		submissions: {
			keyPath: "id",
			indexes: {
				submissions_by_request: ["conversationId", "requestId"],
				submissions_by_conversation: ["conversationId", "id"],
				submissions_by_status: ["status", "id"],
			},
		},
		documents: {
			keyPath: "id",
			indexes: {
				documents_by_address: ["kind", "scopeKind", "ownerId", "family", "keyValue", "createdAt", "id"],
				documents_by_scope: ["scopeKind", "ownerId", "id"],
				documents_by_scope_kind: ["scopeKind", "ownerId", "kind", "id"],
			},
		},
		document_revisions: {
			keyPath: ["documentId", "seq"],
			indexes: { document_revisions_by_kind: ["documentId", "kind", "seq"] },
		},
	};
	for (const [name, definition] of Object.entries(definitions)) {
		const store = db.createObjectStore(name, { keyPath: definition.keyPath });
		for (const [index, path] of Object.entries(definition.indexes)) store.createIndex(index, path);
	}
}
function mutations(writes: readonly T.StorageWrite[]) {
	const map = new Map<T.DocumentId, Mutation>();
	for (const write of writes) {
		if (write.type === "conversation" || write.type === "entry" || write.type === "task" || write.type === "submission")
			continue;
		const id = write.type === "document.create" || write.type === "document.copy" ? write.record.id : write.id;
		const edit = map.get(id) ?? { retire: false };
		map.set(id, edit);
		if (write.type === "document.retire") {
			if (edit.retire) throw new Error(`Document ${id} is retired more than once`);
			edit.retire = true;
		} else {
			if (
				edit.content !== undefined ||
				edit.copy !== undefined ||
				(write.type !== "document.change" && edit.create !== undefined)
			)
				throw new Error(`Document ${id} has more than one content command`);
			if (write.type === "document.copy") {
				edit.create = write.record;
				edit.copy = write.source;
			} else {
				edit.content = write.content;
				if (write.type === "document.create") edit.create = write.record;
			}
		}
	}
	return map;
}
export class IndexedDbStorage implements T.Storage {
	readonly #database: IDBDatabase;
	#closed = false;
	#closing: Promise<void> | undefined;
	#operations = 0;
	#drained: (() => void) | undefined;
	private constructor(database: IDBDatabase) {
		this.#database = database;
	}
	static async open(name: string, options: IndexedDbStorageOptions = {}): Promise<IndexedDbStorage> {
		const factory = options.indexedDB ?? globalThis.indexedDB;
		if (factory === undefined) throw new Error("IndexedDB is not available");
		const request = factory.open(name, 1);
		request.addEventListener("upgradeneeded", (event) => {
			if (event.oldVersion === 0) schema(request.result);
		});
		const database = await result(request);
		try {
			const tx = database.transaction("meta", "readonly"),
				done = finished(tx);
			const state = await get<Metadata>(tx, "meta", "state");
			await done;
			if (state === undefined) throw new Error("Durable IndexedDB metadata is missing");
			return new IndexedDbStorage(database);
		} catch (error) {
			database.close();
			throw error;
		}
	}
	static async delete(name: string, options: IndexedDbStorageOptions = {}): Promise<void> {
		const factory = options.indexedDB ?? globalThis.indexedDB;
		if (factory === undefined) throw new Error("IndexedDB is not available");
		await result(factory.deleteDatabase(name));
	}
	#assertOpen() {
		if (this.#closed) throw new Error("IndexedDbStorage is closed");
	}
	async #transaction<Value>(
		names: string | readonly string[],
		mode: IDBTransactionMode,
		operation: (tx: IDBTransaction) => Promise<Value>,
	): Promise<Value> {
		this.#assertOpen();
		this.#operations++;
		try {
			const tx = this.#database.transaction(names, mode),
				done = finished(tx);
			try {
				const value = await operation(tx);
				await done;
				return value;
			} catch (error) {
				try {
					tx.abort();
				} catch {}
				try {
					await done;
				} catch {}
				throw error;
			}
		} finally {
			if (--this.#operations === 0) this.#drained?.();
		}
	}
	async mintId<Id extends T.Id<string>>(): Promise<Id> {
		this.#assertOpen();
		return this.#transaction("meta", "readwrite", async (tx) => {
			const state = await get<Metadata>(tx, "meta", "state");
			if (state === undefined) throw new Error("Durable IndexedDB metadata is missing");
			if (!Number.isSafeInteger(state.nextId)) throw new Error("ID space is exhausted");
			await result(tx.objectStore("meta").put({ ...state, nextId: state.nextId + 1 }));
			return idFromNumber<Id>(state.nextId);
		});
	}
	async commit(writes: readonly T.StorageWrite[], adopt: (seq: T.Seq) => void, _context: Context): Promise<T.Seq> {
		this.#assertOpen();
		const edits = mutations(writes);
		const seq = await this.#transaction(stores, "readwrite", async (tx) => {
			const state = await get<Metadata>(tx, "meta", "state");
			if (!state) throw new Error("Durable IndexedDB metadata is missing");
			const seq = seqFromNumber(state.nextSeq);
			const claimed = new Map<number, Table>();
			for (const write of writes) {
				if (write.type === "document.change" || write.type === "document.retire") continue;
				const document = write.type === "document.create" || write.type === "document.copy";
				const table: Table = document ? "document" : write.type,
					id = document ? write.record.id : write.value.id;
				const previous = (await get<{ id: number; recordType: Table }>(tx, "record_ids", id))?.recordType,
					earlier = claimed.get(id);
				if (table === "conversation" || table === "entry" || table === "document") {
					if (previous !== undefined) throw new Error(`ID ${id} already belongs to ${previous}`);
					if (earlier !== undefined) throw new Error(`ID ${id} is written more than once`);
				} else {
					if (previous !== undefined && previous !== table) throw new Error(`ID ${id} already belongs to ${previous}`);
					if (earlier !== undefined && earlier !== table) throw new Error(`ID ${id} is written as two record types`);
				}
				claimed.set(id, table);
			}
			const live = new Map<string, number>();
			for (const [id, edit] of edits) {
				if (edit.copy && edits.has(edit.copy.id))
					throw new Error(`Document copy ${id} source is changed in the copy batch`);
				const old = (await get<DocumentRow>(tx, "documents", id))?.record;
				if (!edit.create && !old) throw new Error(`Unknown document: ${id}`);
				if (edit.create && old) throw new Error(`Document ${id} already exists`);
				if (old?.retiredAt !== undefined) throw new Error(`Document ${id} is retired`);
				if (edit.content?.kind === "delta") {
					const previous = await first<Revision>(tx.objectStore("document_revisions"), range([id]), "prev");
					if (!previous) throw new Error(`Document ${id} delta has no base`);
					if (previous.version !== edit.content.version)
						throw new Error(`Document ${id} version transition requires a base`);
				}
				const record = edit.create ?? old!;
				const key = JSON.stringify(addressPrefix(record));
				let count = live.get(key);
				if (count === undefined) count = (await this.#findDocument(tx, record, "current")) ? 1 : 0;
				if (edit.retire && old) count--;
				if (edit.create && !edit.retire) count++;
				live.set(key, count);
			}
			for (const count of live.values())
				if (count > 1) throw new Error("Document address already has a current incarnation");
			const claim = async (id: number, recordType: Table) => {
				await result(tx.objectStore("record_ids").put({ id, recordType }));
			};
			for (const write of writes) {
				switch (write.type) {
					case "conversation":
						await claim(write.value.id, write.type);
						await result(
							tx.objectStore("conversations").add({
								id: write.value.id,
								...(write.value.owner
									? { ownerConversationId: write.value.owner.conversationId, ownerTaskId: write.value.owner.taskId }
									: {}),
								record: write.value,
							} satisfies ConversationRow),
						);
						break;
					case "entry":
						await claim(write.value.id, write.type);
						await result(
							tx.objectStore("entries").add({
								id: write.value.id,
								conversationId: write.value.conversationId,
								...(write.value.head === undefined ? {} : { headConversationId: write.value.conversationId }),
								commitSeq: seq,
								record: write.value,
							} satisfies EntryRow),
						);
						break;
					case "task":
						await claim(write.value.id, write.type);
						await result(
							tx.objectStore("tasks").put({
								id: write.value.id,
								conversationId: write.value.conversationId,
								kind: write.value.kind,
								status: write.value.state.status,
								abortRequested: write.value.abortRequested ? 1 : 0,
								background: write.value.background ? 1 : 0,
								record: write.value,
							} satisfies TaskRow),
						);
						break;
					case "submission":
						await claim(write.value.id, write.type);
						await result(
							tx.objectStore("submissions").put({
								id: write.value.id,
								conversationId: write.value.conversationId,
								...(write.value.requestId === undefined ? {} : { requestId: write.value.requestId }),
								status: write.value.status,
								record: write.value,
							} satisfies SubmissionRow),
						);
						break;
				}
			}
			for (const [id, edit] of edits) {
				let content = edit.content;
				if (edit.copy) {
					try {
						const source = await this.#document(tx, edit.copy.id, edit.copy.at),
							target = edit.create!;
						if (!source) throw new Error(`Fork source document ${edit.copy.id} cannot be read`);
						if (
							source.record.scope.kind !== "conversation" ||
							target.scope.kind !== "conversation" ||
							source.record.kind !== target.kind ||
							source.record.key !== target.key ||
							source.record.history !== target.history ||
							source.record.fork !== target.fork
						)
							throw new Error(`Fork source document ${edit.copy.id} does not match the copied record`);
						content = { kind: "base", version: source.version, value: source.value };
					} catch (cause) {
						throw new Error(`Document copy ${id} was rejected`, { cause });
					}
				}
				let record: T.DocumentRecord;
				if (edit.create) {
					record = { ...edit.create, createdAt: seq, ...(edit.retire ? { retiredAt: seq } : {}) };
					await claim(id, "document");
					await result(tx.objectStore("documents").add(this.#documentRow(record)));
				} else record = (await get<DocumentRow>(tx, "documents", id))!.record;
				if (content) {
					if (content.kind === "base" && currentOnly(record))
						await result(tx.objectStore("document_revisions").delete(range([id])));
					await result(
						tx.objectStore("document_revisions").add({
							documentId: id,
							seq,
							kind: content.kind,
							version: content.version,
							content: content.kind === "base" ? content.value : content.ops,
						} satisfies Revision),
					);
				}
				if (edit.retire) {
					if (!edit.create) {
						record = { ...record, retiredAt: seq };
						await result(tx.objectStore("documents").put(this.#documentRow(record)));
					}
					if (currentOnly(record)) await result(tx.objectStore("document_revisions").delete(range([id])));
				}
			}
			let nextId = state.nextId;
			for (const write of writes) {
				if (write.type === "document.change" || write.type === "document.retire") continue;
				nextId = Math.max(
					nextId,
					(write.type === "document.create" || write.type === "document.copy" ? write.record.id : write.value.id) + 1,
				);
			}
			await result(tx.objectStore("meta").put({ key: "state", nextId, nextSeq: seq + 1 } satisfies Metadata));
			return seq;
		});
		adopt(seq);
		return seq;
	}
	#documentRow(record: T.DocumentRecord): DocumentRow {
		return {
			id: record.id,
			...address(record),
			createdAt: record.createdAt,
			...(record.retiredAt === undefined ? {} : { retiredAt: record.retiredAt }),
			record,
		};
	}
	async #conversation(tx: IDBTransaction, id: T.ConversationId) {
		return (await get<ConversationRow>(tx, "conversations", id))?.record;
	}
	conversation(id: T.ConversationId, _context: Context) {
		return this.#transaction("conversations", "readonly", (tx) => this.#conversation(tx, id));
	}
	async #scan<Row extends { id: number }>(
		tx: IDBTransaction,
		store: string,
		index: string | undefined,
		prefix: readonly IDBValidKey[] | undefined,
		order: T.ScanOrder | undefined,
		cursor: T.Cursor | undefined,
		limit: number,
		accept: (row: Row) => boolean,
	): Promise<Row[]> {
		const start = scanPosition(order, cursor, "ascending"),
			direction = start.order === "ascending" ? "next" : "prev";
		const source = index ? tx.objectStore(store).index(index) : tx.objectStore(store);
		const keys = prefix
			? range(
					prefix,
					start.order === "ascending" ? (start.after ?? 0) : 0,
					start.order === "descending" ? (start.after ?? maximum) : maximum,
					start.order === "ascending" && start.after !== undefined,
					start.order === "descending" && start.after !== undefined,
				)
			: start.after === undefined
				? null
				: start.order === "ascending"
					? keyRanges().lowerBound(start.after, true)
					: keyRanges().upperBound(start.after, true);
		return values(source, keys, direction, limit + 1, accept);
	}
	async scanConversations(query: T.ConversationQuery, limit: number, cursor: T.Cursor | undefined, _context: Context) {
		const start = scanPosition(query.order, cursor, "ascending");
		return this.#transaction("conversations", "readonly", async (tx) => {
			const index =
				query.ownerTaskId !== undefined
					? "conversations_by_owner_task"
					: query.ownerConversationId !== undefined
						? "conversations_by_owner_conversation"
						: undefined;
			const owner = query.ownerTaskId ?? query.ownerConversationId;
			const rows = await this.#scan<ConversationRow>(
				tx,
				"conversations",
				index,
				owner === undefined ? undefined : [owner],
				query.order,
				cursor,
				limit,
				(row) => query.ownerConversationId === undefined || row.ownerConversationId === query.ownerConversationId,
			);
			return page(
				rows.map((row) => row.record),
				limit,
				start.order,
			);
		});
	}
	entry(id: T.EntryId, context: Context): ReturnType<T.Storage["entry"]>;
	entry(conversationId: T.ConversationId, id: T.EntryId, context: Context): ReturnType<T.Storage["entry"]>;
	entry(
		firstId: T.EntryId | T.ConversationId,
		second: T.EntryId | Context,
		third?: Context,
	): ReturnType<T.Storage["entry"]> {
		return this.#transaction(["conversations", "entries"], "readonly", async (tx) => {
			const id =
				third === undefined
					? idFromNumber<T.EntryId>(firstId)
					: typeof second === "number"
						? idFromNumber<T.EntryId>(second)
						: undefined;
			if (id === undefined) throw new StorageRequestError("Storage.entry() requires an entry ID");
			let conversation =
				third === undefined ? undefined : await this.#conversation(tx, idFromNumber<T.ConversationId>(firstId));
			if (third !== undefined && !conversation) throw new StorageRequestError(`Unknown conversation: ${firstId}`);
			const row = await get<EntryRow>(tx, "entries", id);
			if (!row) return undefined;
			if (conversation) {
				let upper = maximum;
				while (conversation.id !== row.conversationId) {
					if (!conversation.parent) return undefined;
					upper = Math.min(upper, conversation.parent.at);
					conversation = (await this.#conversation(tx, conversation.parent.conversationId))!;
				}
				if (row.id > upper) return undefined;
			}
			return { entry: row.record, commitSeq: row.commitSeq };
		});
	}
	async findLatestHeadMarker(
		conversationId: T.ConversationId,
		at: T.EntryId | undefined,
		_context: Context,
	): Promise<(T.EntryRecord & { readonly head: T.EntryId }) | undefined> {
		return this.#transaction(["conversations", "entries"], "readonly", async (tx) => {
			let conversation = await this.#conversation(tx, conversationId);
			if (!conversation) throw new StorageRequestError(`Unknown conversation: ${conversationId}`);
			let upper = at ?? maximum;
			for (;;) {
				const row = await first<EntryRow>(
					tx.objectStore("entries").index("entry_heads_by_conversation"),
					range([conversation.id], 0, upper),
					"prev",
				);
				if (row?.record.head !== undefined) return { ...row.record, head: row.record.head };
				if (!conversation.parent) return undefined;
				upper = Math.min(upper, conversation.parent.at);
				conversation = (await this.#conversation(tx, conversation.parent.conversationId))!;
			}
		});
	}
	async scanEntries(query: T.EntryQuery, limit: number, cursor: T.Cursor | undefined, _context: Context) {
		const start = scanPosition(query.order, cursor, "descending");
		return this.#transaction(["conversations", "entries"], "readonly", async (tx) => {
			let conversation = await this.#conversation(tx, query.conversationId);
			if (!conversation) throw new StorageRequestError(`Unknown conversation: ${query.conversationId}`);
			let upper = query.maxEntryId ?? maximum;
			const requestedMinimum = query.minEntryId ?? 0,
				entries: T.EntryRecord[] = [],
				index = tx.objectStore("entries").index("entries_by_conversation");
			if (start.order === "descending") {
				upper = Math.min(upper, start.after === undefined ? maximum : start.after - 1);
				for (;;) {
					if (upper >= requestedMinimum)
						entries.push(
							...(
								await values<EntryRow>(
									index,
									range([conversation.id], requestedMinimum, upper),
									"prev",
									limit + 1 - entries.length,
								)
							).map((row) => row.record),
						);
					if (entries.length > limit || !conversation.parent) break;
					upper = Math.min(upper, conversation.parent.at);
					if (upper < requestedMinimum) break;
					conversation = (await this.#conversation(tx, conversation.parent.conversationId))!;
				}
			} else {
				const segments: { id: T.ConversationId; upper: number }[] = [];
				for (;;) {
					segments.push({ id: conversation.id, upper });
					if (!conversation.parent) break;
					upper = Math.min(upper, conversation.parent.at);
					if (upper < requestedMinimum) break;
					conversation = (await this.#conversation(tx, conversation.parent.conversationId))!;
				}
				const lower = Math.max(requestedMinimum, start.after === undefined ? requestedMinimum : start.after + 1);
				for (const segment of segments.reverse()) {
					if (segment.upper < lower) continue;
					entries.push(
						...(
							await values<EntryRow>(
								index,
								range([segment.id], lower, segment.upper),
								"next",
								limit + 1 - entries.length,
							)
						).map((row) => row.record),
					);
					if (entries.length > limit) break;
				}
			}
			return page(entries, limit, start.order);
		});
	}
	task(id: T.TaskId, _context: Context) {
		return this.#transaction("tasks", "readonly", async (tx) => (await get<TaskRow>(tx, "tasks", id))?.record);
	}
	async scanTasks(query: T.TaskQuery, limit: number, cursor: T.Cursor | undefined, _context: Context) {
		const start = scanPosition(query.order, cursor, "ascending");
		return this.#transaction("tasks", "readonly", async (tx) => {
			let index: string | undefined, prefix: IDBValidKey[] | undefined;
			if (query.status !== undefined) {
				index = "tasks_by_status";
				prefix = [query.status];
			} else if (query.conversationId !== undefined) {
				index = "tasks_by_conversation";
				prefix = [query.conversationId];
			} else if (query.kind !== undefined) {
				index = "tasks_by_kind";
				prefix = [query.kind];
			} else if (query.abortRequested !== undefined) {
				index = "tasks_by_abort_requested";
				prefix = [query.abortRequested ? 1 : 0];
			} else if (query.background !== undefined) {
				index = "tasks_by_background";
				prefix = [query.background ? 1 : 0];
			}
			const rows = await this.#scan<TaskRow>(
				tx,
				"tasks",
				index,
				prefix,
				query.order,
				cursor,
				limit,
				(row) =>
					(query.conversationId === undefined || row.conversationId === query.conversationId) &&
					(query.kind === undefined || row.kind === query.kind) &&
					(query.status === undefined || row.status === query.status) &&
					(query.abortRequested === undefined || row.abortRequested === (query.abortRequested ? 1 : 0)) &&
					(query.background === undefined || row.background === (query.background ? 1 : 0)),
			);
			return page(
				rows.map((row) => row.record),
				limit,
				start.order,
			);
		});
	}
	submission(id: T.SubmissionId, _context: Context) {
		return this.#transaction(
			"submissions",
			"readonly",
			async (tx) => (await get<SubmissionRow>(tx, "submissions", id))?.record,
		);
	}
	async scanSubmissions(query: T.SubmissionQuery, limit: number, cursor: T.Cursor | undefined, _context: Context) {
		const start = scanPosition(query.order, cursor, "ascending");
		return this.#transaction("submissions", "readonly", async (tx) => {
			const index =
					query.status !== undefined
						? "submissions_by_status"
						: query.conversationId !== undefined
							? "submissions_by_conversation"
							: undefined,
				value = query.status ?? query.conversationId;
			const rows = await this.#scan<SubmissionRow>(
				tx,
				"submissions",
				index,
				value === undefined ? undefined : [value],
				query.order,
				cursor,
				limit,
				(row) => query.conversationId === undefined || row.conversationId === query.conversationId,
			);
			return page(
				rows.map((row) => row.record),
				limit,
				start.order,
			);
		});
	}
	submissionByRequest(conversation: T.ConversationId, request: string, _context: Context) {
		return this.#transaction("submissions", "readonly", async (tx) => {
			const row: SubmissionRow | undefined = await result(
				tx.objectStore("submissions").index("submissions_by_request").get([conversation, request]),
			);
			return row?.record;
		});
	}
	async #findDocument(tx: IDBTransaction, address: T.DocumentAddress, at: T.DocumentPoint) {
		const prefix = addressPrefix(address);
		return (
			await first<DocumentRow>(
				tx.objectStore("documents").index("documents_by_address"),
				keyRanges().bound([...prefix, 0, 0], [...prefix, maximum, maximum]),
				"prev",
				(row) => alive(row.record, at),
			)
		)?.record;
	}
	findDocument(address: T.DocumentAddress, at: T.DocumentPoint, _context: Context) {
		return this.#transaction("documents", "readonly", (tx) => this.#findDocument(tx, address, at));
	}
	async #document(tx: IDBTransaction, id: T.DocumentId, at: T.DocumentPoint): Promise<T.StoredDocument | undefined> {
		const record = (await get<DocumentRow>(tx, "documents", id))?.record;
		if (!record) return undefined;
		if (at !== "current" && currentOnly(record))
			throw new StorageRequestError(`Document ${id} does not retain historical content`);
		if (!alive(record, at)) return undefined;
		const upper = at === "current" ? maximum : at,
			store = tx.objectStore("document_revisions");
		const base = await first<Revision>(
			store.index("document_revisions_by_kind"),
			keyRanges().bound([id, "base", 0], [id, "base", upper]),
			"prev",
		);
		if (!base || base.kind !== "base") throw new Error(`Document ${id} is missing a required base`);
		let value = base.content as T.JsonObject;
		const tail =
			base.seq >= upper ? [] : await values<Revision>(store, range([id], base.seq, upper, true), "next", maximum);
		for (const revision of tail) {
			if (revision.kind !== "delta" || revision.version !== base.version)
				throw new Error(`Document ${id} crosses a stored version boundary without a base`);
			value = apply(value, revision.content as readonly Op[]);
		}
		return { record, version: base.version, value, deltasSinceBase: tail.length };
	}
	document(id: T.DocumentId, at: T.DocumentPoint, _context: Context) {
		return this.#transaction(["documents", "document_revisions"], "readonly", (tx) => this.#document(tx, id, at));
	}
	async scanDocuments(query: T.DocumentQuery, limit: number, cursor: T.Cursor | undefined, _context: Context) {
		const after = cursor?.after;
		if (after !== undefined && (typeof after !== "number" || !Number.isSafeInteger(after)))
			throw new StorageRequestError("Invalid storage cursor");
		return this.#transaction("documents", "readonly", async (tx) => {
			const s = scope(query.scope),
				prefix: IDBValidKey[] = [s.scopeKind, s.ownerId];
			if (query.kind !== undefined) prefix.push(query.kind);
			const index = tx
				.objectStore("documents")
				.index(query.kind === undefined ? "documents_by_scope" : "documents_by_scope_kind");
			const rows = await values<DocumentRow>(
				index,
				range(prefix, after ?? 0, maximum, after !== undefined),
				"next",
				limit + 1,
				(row) => alive(row.record, query.at),
			);
			return page(
				rows.map((row) => row.record),
				limit,
			);
		});
	}
	close(_context: Context): Promise<void> {
		if (!this.#closing) {
			this.#closed = true;
			this.#closing = (async () => {
				if (this.#operations > 0)
					await new Promise<void>((resolve) => {
						this.#drained = resolve;
					});
				this.#database.close();
			})();
		}
		return this.#closing;
	}
}
