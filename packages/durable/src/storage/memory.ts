import type { Context, JsonValue } from "@axi/chord";
import { applyImmutableBatches, type Op } from "@axi/chord/delta";
import { StorageRequestError } from "../errors.ts";
import { idFromNumber, seqFromNumber } from "../ids.ts";
import type {
	ConversationId,
	ConversationQuery,
	ConversationRecord,
	Cursor,
	DocumentAddress,
	DocumentContent,
	DocumentCreate,
	DocumentId,
	DocumentPoint,
	DocumentQuery,
	DocumentRecord,
	EntryId,
	EntryQuery,
	EntryRecord,
	Id,
	Page,
	ScanOrder,
	Seq,
	Storage,
	StorageWrite,
	StoredDocument,
	SubmissionId,
	SubmissionQuery,
	SubmissionRecord,
	TaskId,
	TaskQuery,
	TaskRecord,
} from "../types.ts";
import { scanPosition } from "./rows.ts";

type StoredTask = TaskRecord<JsonValue, JsonValue, JsonValue>;
type Revision = DocumentContent & { readonly seq: Seq };
type DocumentRow = { record: DocumentRecord; revisions: Revision[] };
type DocumentIndex = { ids: DocumentId[]; currentId?: DocumentId };
type DocumentMutation = { creation?: DocumentCreate; revision?: DocumentContent; retirement: boolean };
type Table = "conversation" | "entry" | "task" | "submission" | "document";
type ResolvedWrite = Exclude<StorageWrite, { readonly type: "document.copy" }>;

function copy<Value>(value: Value): Value {
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map(copy) as Value;
	const result: Record<string, unknown> = Object.getPrototypeOf(value) === null ? Object.create(null) : {};
	for (const key of Object.keys(value)) {
		const child = copy(Reflect.get(value, key));
		if (key in result)
			Object.defineProperty(result, key, { value: child, enumerable: true, configurable: true, writable: true });
		else result[key] = child;
	}
	return result as Value;
}
function seal<Value>(value: Value): Value {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		for (const child of Object.values(value)) seal(child);
		Object.freeze(value);
	}
	return value;
}
function scopeKey(scope: DocumentRecord["scope"]): string {
	switch (scope.kind) {
		case "session":
			return JSON.stringify(["session"]);
		case "conversation":
			return JSON.stringify(["conversation", scope.conversationId]);
		case "task":
			return JSON.stringify(["task", scope.taskId]);
	}
}
function addressKey(address: DocumentAddress): string {
	return JSON.stringify([
		address.kind,
		scopeKey(address.scope),
		address.key === undefined ? ["singleton"] : ["family", address.key],
	]);
}
function alive(record: DocumentRecord, at: DocumentPoint): boolean {
	return at === "current"
		? record.retiredAt === undefined
		: record.createdAt <= at && (record.retiredAt === undefined || at < record.retiredAt);
}
function currentOnly(record: DocumentRecord): boolean {
	return record.scope.kind !== "conversation" || record.history === "latest";
}
function page<Item extends { readonly id: number }>(
	items: readonly Item[],
	limit: number,
	order: ScanOrder = "ascending",
): Page<Item, Cursor> {
	const selected = items.slice(0, limit);
	return items.length <= limit
		? { items: copy(selected) }
		: { items: copy(selected), next: { after: selected[selected.length - 1].id, order } };
}
function bound(ids: readonly number[], value: number, inclusive: boolean): number {
	let from = 0,
		to = ids.length;
	while (from < to) {
		const middle = (from + to) >>> 1;
		if (ids[middle] < value || (inclusive && ids[middle] === value)) from = middle + 1;
		else to = middle;
	}
	return from;
}
function insert<Id extends number>(ids: Id[], id: Id): void {
	if (!ids.length || ids[ids.length - 1] < id) ids.push(id);
	else ids.splice(bound(ids, id, false), 0, id);
}
function remove<Id extends number>(ids: Id[], id: Id): void {
	const at = bound(ids, id, false);
	if (ids[at] === id) ids.splice(at, 1);
}
function index<Key, Id extends number>(groups: Map<Key, Id[]>, key: Key, id: Id): void {
	let ids = groups.get(key);
	if (ids === undefined) {
		ids = [];
		groups.set(key, ids);
	}
	insert(ids, id);
}
function* scanIds<Id extends number>(ids: readonly Id[], order: ScanOrder, after?: number): Generator<Id> {
	if (order === "ascending") {
		for (let at = after === undefined ? 0 : bound(ids, after, true); at < ids.length; at++) yield ids[at];
	} else {
		for (let at = (after === undefined ? ids.length : bound(ids, after, false)) - 1; at >= 0; at--) yield ids[at];
	}
}
function* deltaBatches(
	id: DocumentId,
	version: number,
	revisions: readonly Revision[],
	start: number,
): Generator<readonly Op[]> {
	for (let at = start; at < revisions.length; at++) {
		const revision = revisions[at];
		if (revision.kind !== "delta" || revision.version !== version)
			throw new Error(`Document ${id} crosses a stored version boundary without a base`);
		yield revision.ops;
	}
}

export interface PreparedMemoryCommit {
	readonly seq: Seq;
	readonly writes: readonly StorageWrite[];
	apply(): Seq;
}

export class MemoryStorage implements Storage {
	readonly #claims = new Map<number, Table>();
	readonly #conversations = new Map<ConversationId, ConversationRecord>();
	readonly #conversationIds: ConversationId[] = [];
	readonly #byOwnerConversation = new Map<ConversationId, ConversationId[]>();
	readonly #byOwnerTask = new Map<TaskId, ConversationId[]>();
	readonly #entries = new Map<EntryId, EntryRecord>();
	readonly #entryIds = new Map<ConversationId, EntryId[]>();
	readonly #headIds = new Map<ConversationId, EntryId[]>();
	readonly #entrySeqs = new Map<EntryId, Seq>();
	readonly #tasks = new Map<TaskId, StoredTask>();
	readonly #taskIds: TaskId[] = [];
	readonly #tasksByStatus: Record<StoredTask["state"]["status"], TaskId[]> = {
		pending: [],
		running: [],
		waiting: [],
		sleeping: [],
		completing: [],
		terminal: [],
	};
	readonly #submissions = new Map<SubmissionId, SubmissionRecord>();
	readonly #submissionIds: SubmissionId[] = [];
	readonly #submissionsByStatus: Record<SubmissionRecord["status"], SubmissionId[]> = {
		queued: [],
		placed: [],
		done: [],
		unanswered: [],
	};
	readonly #requests = new Map<ConversationId, Map<string, SubmissionId>>();
	readonly #documents = new Map<DocumentId, DocumentRow>();
	readonly #addresses = new Map<string, DocumentIndex>();
	readonly #documentsByScope = new Map<string, DocumentId[]>();
	#nextId = 2;
	#nextSeq = 1;
	private closed = false;
	#open(): void {
		if (this.closed) throw new Error("MemoryStorage is closed");
	}
	async close(_context: Context): Promise<void> {
		this.closed = true;
	}
	async mintId<RecordId extends Id<string>>(): Promise<RecordId> {
		this.#open();
		if (!Number.isSafeInteger(this.#nextId)) throw new Error("ID space is exhausted");
		return idFromNumber<RecordId>(this.#nextId++);
	}
	async commit(writes: readonly StorageWrite[], adopt: (seq: Seq) => void, _context: Context): Promise<Seq> {
		const seq = this.prepareCommit(writes).apply();
		adopt(seq);
		return seq;
	}
	prepareCommit(writes: readonly StorageWrite[], seq = seqFromNumber(this.#nextSeq)): PreparedMemoryCommit {
		this.#open();
		if (!Number.isSafeInteger(seq) || seq < this.#nextSeq)
			throw new Error(`Commit sequence ${seq} does not strictly increase`);
		const detached = seal(this.#resolveCopies(copy(writes)));
		this.#validateClaims(detached);
		const documents = this.#prepareDocuments(detached);
		let applied = false;
		return {
			seq,
			writes: detached,
			apply: () => {
				if (!applied) {
					applied = true;
					for (const write of detached) this.#applyRow(write, seq);
					this.#applyDocuments(documents, seq);
					this.#nextSeq = seq + 1;
				}
				return seq;
			},
		};
	}
	#resolveCopies(writes: readonly StorageWrite[]): readonly ResolvedWrite[] {
		if (writes.every((write): write is ResolvedWrite => write.type !== "document.copy")) return writes;
		const changed = new Set<DocumentId>();
		for (const write of writes) {
			if (write.type === "document.create" || write.type === "document.copy") changed.add(write.record.id);
			else if (write.type === "document.change" || write.type === "document.retire") changed.add(write.id);
		}
		return writes.map((write) => {
			if (write.type !== "document.copy") return write;
			try {
				if (changed.has(write.source.id))
					throw new Error(`Fork source document ${write.source.id} is changed in the copy batch`);
				const source = this.#materialize(write.source.id, write.source.at);
				if (source === undefined) throw new Error(`Fork source document ${write.source.id} cannot be read`);
				if (
					source.record.scope.kind !== "conversation" ||
					write.record.scope.kind !== "conversation" ||
					source.record.kind !== write.record.kind ||
					source.record.key !== write.record.key ||
					source.record.history !== write.record.history ||
					source.record.fork !== write.record.fork
				)
					throw new Error(`Fork source document ${write.source.id} does not match the copied record`);
				return {
					type: "document.create",
					record: write.record,
					content: { kind: "base", version: source.version, value: source.value },
				};
			} catch (cause) {
				throw new Error(`Document copy ${write.record.id} was rejected`, { cause });
			}
		});
	}
	#validateClaims(writes: readonly ResolvedWrite[]): void {
		const batch = new Map<number, Table>();
		for (const write of writes) {
			if (write.type === "document.change" || write.type === "document.retire") continue;
			const table = write.type === "document.create" ? "document" : write.type;
			const id = write.type === "document.create" ? write.record.id : write.value.id;
			const existing = this.#claims.get(id),
				earlier = batch.get(id);
			const immutable = table === "conversation" || table === "entry" || table === "document";
			if (existing !== undefined && (existing !== table || immutable))
				throw new Error(`ID ${id} already belongs to ${existing}`);
			if (earlier !== undefined && (earlier !== table || immutable))
				throw new Error(`ID ${id} is written ${immutable ? "more than once" : "as two record types"}`);
			batch.set(id, table);
		}
	}
	#prepareDocuments(writes: readonly ResolvedWrite[]): Map<DocumentId, DocumentMutation> {
		const mutations = new Map<DocumentId, DocumentMutation>();
		for (const write of writes) {
			if (write.type !== "document.create" && write.type !== "document.change" && write.type !== "document.retire")
				continue;
			const id = write.type === "document.create" ? write.record.id : write.id;
			let mutation = mutations.get(id);
			if (!mutation) {
				mutation = { retirement: false };
				mutations.set(id, mutation);
			}
			if (write.type === "document.retire") {
				if (mutation.retirement) throw new Error(`Document ${id} is retired more than once`);
				mutation.retirement = true;
			} else {
				if (mutation.revision !== undefined) throw new Error(`Document ${id} has more than one content command`);
				mutation.revision = write.content;
				if (write.type === "document.create") mutation.creation = write.record;
			}
		}
		const counts = new Map<string, number>();
		for (const [id, mutation] of mutations) {
			const stored = this.#documents.get(id);
			if (!stored && !mutation.creation) throw new Error(`Unknown document: ${id}`);
			if (stored?.record.retiredAt !== undefined) throw new Error(`Document ${id} is retired`);
			if (mutation.creation && stored) throw new Error(`Document ${id} already exists`);
			if (mutation.revision?.kind === "delta") {
				const previous = stored?.revisions.at(-1);
				if (!previous) throw new Error(`Document ${id} delta has no base`);
				if (previous.version !== mutation.revision.version)
					throw new Error(`Document ${id} version transition requires a base`);
			}
			const key = addressKey(mutation.creation ?? stored!.record);
			const current = this.#addresses.get(key)?.currentId;
			let count = counts.get(key) ?? (current === undefined ? 0 : 1);
			if (mutation.retirement && current === id) count--;
			if (mutation.creation && !mutation.retirement) count++;
			counts.set(key, count);
		}
		for (const count of counts.values())
			if (count > 1) throw new Error("Document address already has a current incarnation");
		return mutations;
	}
	#claim(id: number, table: Table): void {
		this.#claims.set(id, table);
		this.#nextId = Math.max(this.#nextId, id + 1);
	}
	#applyRow(write: ResolvedWrite, seq: Seq): void {
		switch (write.type) {
			case "conversation":
				this.#conversations.set(write.value.id, write.value);
				insert(this.#conversationIds, write.value.id);
				if (write.value.owner !== undefined) {
					index(this.#byOwnerConversation, write.value.owner.conversationId, write.value.id);
					index(this.#byOwnerTask, write.value.owner.taskId, write.value.id);
				}
				this.#claim(write.value.id, write.type);
				break;
			case "entry":
				this.#entries.set(write.value.id, write.value);
				this.#entrySeqs.set(write.value.id, seq);
				index(this.#entryIds, write.value.conversationId, write.value.id);
				if (write.value.head !== undefined) index(this.#headIds, write.value.conversationId, write.value.id);
				this.#claim(write.value.id, write.type);
				break;
			case "task": {
				const previous = this.#tasks.get(write.value.id);
				if (previous === undefined) {
					insert(this.#taskIds, write.value.id);
					insert(this.#tasksByStatus[write.value.state.status], write.value.id);
				} else if (previous.state.status !== write.value.state.status) {
					remove(this.#tasksByStatus[previous.state.status], write.value.id);
					insert(this.#tasksByStatus[write.value.state.status], write.value.id);
				}
				this.#tasks.set(write.value.id, write.value);
				this.#claim(write.value.id, write.type);
				break;
			}
			case "submission": {
				const previous = this.#submissions.get(write.value.id);
				if (previous === undefined) {
					insert(this.#submissionIds, write.value.id);
					insert(this.#submissionsByStatus[write.value.status], write.value.id);
				} else if (previous.status !== write.value.status) {
					remove(this.#submissionsByStatus[previous.status], write.value.id);
					insert(this.#submissionsByStatus[write.value.status], write.value.id);
				}
				if (previous?.requestId !== undefined) {
					const requests = this.#requests.get(previous.conversationId);
					if (requests?.get(previous.requestId) === previous.id) {
						requests.delete(previous.requestId);
						if (!requests.size) this.#requests.delete(previous.conversationId);
					}
				}
				this.#submissions.set(write.value.id, write.value);
				if (write.value.requestId !== undefined) {
					let requests = this.#requests.get(write.value.conversationId);
					if (requests === undefined) {
						requests = new Map();
						this.#requests.set(write.value.conversationId, requests);
					}
					requests.set(write.value.requestId, write.value.id);
				}
				this.#claim(write.value.id, write.type);
				break;
			}
			case "document.create":
			case "document.change":
			case "document.retire":
				break;
			default: {
				const remaining: never = write;
				return remaining;
			}
		}
	}
	#applyDocuments(mutations: ReadonlyMap<DocumentId, DocumentMutation>, seq: Seq): void {
		for (const [id, mutation] of mutations) {
			let row = this.#documents.get(id);
			if (mutation.creation !== undefined) {
				const record = { ...mutation.creation, createdAt: seq, ...(mutation.retirement ? { retiredAt: seq } : {}) };
				row = { record, revisions: [{ ...mutation.revision!, seq }] };
				this.#documents.set(id, row);
				const key = addressKey(record);
				let address = this.#addresses.get(key);
				if (address === undefined) {
					address = { ids: [] };
					this.#addresses.set(key, address);
				}
				insert(address.ids, id);
				index(this.#documentsByScope, scopeKey(record.scope), id);
				this.#claim(id, "document");
			} else if (mutation.revision !== undefined) {
				const revision = { ...mutation.revision, seq };
				if (revision.kind === "base" && currentOnly(row!.record)) row!.revisions = [revision];
				else row!.revisions.push(revision);
			}
			if (mutation.retirement) {
				if (!mutation.creation) row!.record = { ...row!.record, retiredAt: seq };
				if (currentOnly(row!.record)) row!.revisions = [];
			}
			if (mutation.creation !== undefined || mutation.retirement) {
				const address = this.#addresses.get(addressKey(row!.record))!;
				if (mutation.retirement && address.currentId === id) delete address.currentId;
				if (mutation.creation !== undefined && !mutation.retirement) address.currentId = id;
			}
		}
	}
	async conversation(id: ConversationId, _context: Context): Promise<ConversationRecord | undefined> {
		this.#open();
		return copy(this.#conversations.get(id));
	}
	async scanConversations(
		query: ConversationQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<ConversationRecord, Cursor>> {
		this.#open();
		const { order, after } = scanPosition(query.order, cursor, "ascending");
		const ids =
			query.ownerTaskId !== undefined
				? (this.#byOwnerTask.get(query.ownerTaskId) ?? [])
				: query.ownerConversationId !== undefined
					? (this.#byOwnerConversation.get(query.ownerConversationId) ?? [])
					: this.#conversationIds;
		const rows: ConversationRecord[] = [];
		for (const id of scanIds(ids, order, after)) {
			if (rows.length > limit) break;
			const row = this.#conversations.get(id)!;
			if (query.ownerConversationId !== undefined && row.owner?.conversationId !== query.ownerConversationId) continue;
			rows.push(row);
		}
		return page(rows, limit, order);
	}
	entry(id: EntryId, context: Context): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined>;
	entry(
		conversationId: ConversationId,
		id: EntryId,
		context: Context,
	): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined>;
	async entry(
		first: ConversationId | EntryId,
		second: EntryId | Context,
		context?: Context,
	): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined> {
		this.#open();
		let row: EntryRecord | undefined;
		if (context === undefined) row = this.#entries.get(idFromNumber<EntryId>(first));
		else {
			if (typeof second !== "number") throw new StorageRequestError("Storage.entry() requires an entry ID");
			row = this.#visible(idFromNumber<ConversationId>(first), second, second, "descending").next().value;
		}
		return row === undefined ? undefined : { entry: copy(row), commitSeq: this.#entrySeqs.get(row.id)! };
	}
	*#segments(
		id: ConversationId,
		upper: number,
		lower = -Infinity,
	): Generator<{ conversation: ConversationId; upper: number }> {
		if (!this.#conversations.get(id)) throw new StorageRequestError(`Unknown conversation: ${id}`);
		while (true) {
			yield { conversation: id, upper };
			const parent = this.#conversations.get(id)!.parent;
			if (parent === undefined) return;
			id = parent.conversationId;
			upper = Math.min(upper, parent.at);
			if (upper < lower) return;
		}
	}
	*#visible(conversation: ConversationId, lower: number, upper: number, order: ScanOrder): Generator<EntryRecord> {
		const segments = this.#segments(conversation, upper, lower);
		for (const segment of order === "ascending" ? [...segments].reverse() : segments) {
			const ids = this.#entryIds.get(segment.conversation) ?? [];
			if (order === "ascending") {
				for (let at = bound(ids, lower, false); at < ids.length; at++) {
					const id = ids[at];
					if (id > segment.upper) break;
					yield this.#entries.get(id)!;
				}
			} else {
				for (let at = bound(ids, segment.upper, true) - 1; at >= 0; at--) {
					const id = ids[at];
					if (id < lower) break;
					yield this.#entries.get(id)!;
				}
			}
		}
	}
	async scanEntries(
		query: EntryQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<EntryRecord, Cursor>> {
		this.#open();
		const { order, after } = scanPosition(query.order, cursor, "descending");
		const lower = Math.max(
			query.minEntryId ?? -Infinity,
			order === "ascending" && after !== undefined ? after + 1 : -Infinity,
		);
		const upper = Math.min(
			query.maxEntryId ?? Infinity,
			order === "descending" && after !== undefined ? after - 1 : Infinity,
		);
		const rows: EntryRecord[] = [];
		for (const row of this.#visible(query.conversationId, lower, upper, order)) {
			rows.push(row);
			if (rows.length > limit) break;
		}
		return page(rows, limit, order);
	}
	async findLatestHeadMarker(
		conversation: ConversationId,
		atOrBeforeEntryId: EntryId | undefined,
		_context: Context,
	): Promise<(EntryRecord & { readonly head: EntryId }) | undefined> {
		this.#open();
		for (const segment of this.#segments(conversation, atOrBeforeEntryId ?? Infinity)) {
			const ids = this.#headIds.get(segment.conversation) ?? [];
			const at = bound(ids, segment.upper, true) - 1;
			if (at >= 0) {
				const marker = this.#entries.get(ids[at])!;
				return copy({ ...marker, head: marker.head! });
			}
		}
		return undefined;
	}
	async task(id: TaskId, _context: Context): Promise<StoredTask | undefined> {
		this.#open();
		return copy(this.#tasks.get(id));
	}
	async scanTasks(
		query: TaskQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<StoredTask, Cursor>> {
		this.#open();
		const { order, after } = scanPosition(query.order, cursor, "ascending");
		const ids = query.status === undefined ? this.#taskIds : this.#tasksByStatus[query.status];
		const rows: StoredTask[] = [];
		for (const id of scanIds(ids, order, after)) {
			if (rows.length > limit) break;
			const row = this.#tasks.get(id)!;
			if (query.conversationId !== undefined && query.conversationId !== row.conversationId) continue;
			if (query.kind !== undefined && query.kind !== row.kind) continue;
			if (query.abortRequested !== undefined && query.abortRequested !== row.abortRequested) continue;
			if (query.background !== undefined && query.background !== row.background) continue;
			rows.push(row);
		}
		return page(rows, limit, order);
	}
	async submission(id: SubmissionId, _context: Context): Promise<SubmissionRecord | undefined> {
		this.#open();
		return copy(this.#submissions.get(id));
	}
	async scanSubmissions(
		query: SubmissionQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<SubmissionRecord, Cursor>> {
		this.#open();
		const { order, after } = scanPosition(query.order, cursor, "ascending");
		const ids = query.status === undefined ? this.#submissionIds : this.#submissionsByStatus[query.status];
		const rows: SubmissionRecord[] = [];
		for (const id of scanIds(ids, order, after)) {
			if (rows.length > limit) break;
			const row = this.#submissions.get(id)!;
			if (query.conversationId !== undefined && query.conversationId !== row.conversationId) continue;
			rows.push(row);
		}
		return page(rows, limit, order);
	}
	async submissionByRequest(
		conversation: ConversationId,
		request: string,
		_context: Context,
	): Promise<SubmissionRecord | undefined> {
		this.#open();
		const id = this.#requests.get(conversation)?.get(request);
		return id === undefined ? undefined : copy(this.#submissions.get(id));
	}
	async findDocument(
		address: DocumentAddress,
		at: DocumentPoint,
		_context: Context,
	): Promise<DocumentRecord | undefined> {
		this.#open();
		const addressIndex = this.#addresses.get(addressKey(address));
		if (at === "current") {
			const id = addressIndex?.currentId;
			return id === undefined ? undefined : copy(this.#documents.get(id)!.record);
		}
		for (const id of addressIndex?.ids ?? []) {
			const row = this.#documents.get(id)!;
			if (alive(row.record, at)) return copy(row.record);
		}
		return undefined;
	}
	#materialize(id: DocumentId, at: DocumentPoint): StoredDocument | undefined {
		const row = this.#documents.get(id);
		if (row === undefined) return undefined;
		if (at !== "current" && currentOnly(row.record))
			throw new StorageRequestError(`Document ${id} does not retain historical content`);
		if (!alive(row.record, at)) return undefined;
		const revisions = at === "current" ? row.revisions : row.revisions.filter((revision) => revision.seq <= at);
		let base = revisions.length - 1;
		while (base >= 0 && revisions[base].kind !== "base") base--;
		const revision = revisions[base];
		if (revision?.kind !== "base") throw new Error(`Document ${id} is missing a required base`);
		const value = applyImmutableBatches(revision.value, deltaBatches(id, revision.version, revisions, base + 1));
		return { record: row.record, version: revision.version, value, deltasSinceBase: revisions.length - base - 1 };
	}
	async document(id: DocumentId, at: DocumentPoint, _context: Context): Promise<StoredDocument | undefined> {
		this.#open();
		const stored = this.#materialize(id, at);
		return stored === undefined
			? undefined
			: {
					record: copy(stored.record),
					version: stored.version,
					value: copy(stored.value),
					deltasSinceBase: stored.deltasSinceBase,
				};
	}
	async scanDocuments(
		query: DocumentQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<DocumentRecord, Cursor>> {
		this.#open();
		const after = cursor?.after;
		if (after !== undefined && (typeof after !== "number" || !Number.isSafeInteger(after)))
			throw new StorageRequestError("Invalid storage cursor");
		const ids = this.#documentsByScope.get(scopeKey(query.scope)) ?? [];
		const rows: DocumentRecord[] = [];
		for (let at = after === undefined ? 0 : bound(ids, after, true); at < ids.length && rows.length <= limit; at++) {
			const record = this.#documents.get(ids[at])!.record;
			if (query.kind !== undefined && record.kind !== query.kind) continue;
			if (alive(record, query.at)) rows.push(record);
		}
		return page(rows, limit);
	}
}
