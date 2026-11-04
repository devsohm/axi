import type { Context } from "@axi/objects/context";
import type { JsonValue } from "@axi/objects/json";
import {
	findDocumentEntry,
	listDocumentEntries,
	StoreOwnerTables,
	type Claimant,
	type SeriesCommit,
	type ObjectsStore,
	type Store,
} from "@axi/objects";
import type { SqliteExecutor } from "@axi/objects/sqlite";
import { StorageRequestError } from "../../errors.ts";
import { idFromNumber, seqFromNumber } from "../../ids.ts";
import type * as T from "../../types.ts";
import { scanPosition } from "../rows.ts";
import { DurableCommit, type CommitTables } from "./commit.ts";
import { addressOf, namespaceOf, readAt, recordOfEntry, SCOPE_NAMESPACES, type DocumentRead } from "./documents.ts";
import { storageQueries, type Condition, type StorageQueries, type TableQueries } from "./queries.ts";
import { Conversations, Entries, EntryHeads, RecordIds, Submissions, Tasks, encodeIndexed } from "./tables.ts";

type Task = T.TaskRecord<JsonValue, JsonValue, JsonValue>;
type Entry = { readonly entry: T.EntryRecord; readonly commitSeq: T.Seq };
type Read<Value> =
	| { readonly kind: "found"; readonly value: Value }
	| { readonly kind: "refused"; readonly message: string };
type Start = ReturnType<typeof scanPosition>;
const notFound: Read<undefined> = { kind: "found", value: undefined };
const unknownConversation = (id: T.ConversationId): Read<never> => ({
	kind: "refused",
	message: `Unknown conversation: ${id}`,
});
function told<Value>(result: Read<Value>): Value {
	if (result.kind === "refused") throw new StorageRequestError(result.message);
	return result.value;
}
function documentOf(result: DocumentRead): T.StoredDocument | undefined {
	if (result.kind === "current_only")
		throw new StorageRequestError(`Document ${result.id} does not retain historical content`);
	return result.document;
}
function page<Value extends { readonly id: T.Id<string> }>(
	values: readonly Value[],
	limit: number,
	order: T.ScanOrder,
): T.Page<Value, T.Cursor> {
	const items = values.slice(0, limit);
	return values.length > limit ? { items, next: { after: items.at(-1)!.id, order } } : { items };
}
function scanFrom(start: Start): Condition {
	return start.order === "ascending"
		? ["id", "gt", start.after ?? -1]
		: ["id", "lt", start.after ?? Number.MAX_SAFE_INTEGER];
}
export class StoreStorage implements T.Storage {
	readonly #store: ObjectsStore;
	readonly #owner: string;
	readonly #claimant: Claimant;
	readonly #tables: CommitTables;
	readonly #queries: StorageQueries;
	#closed = false;
	#closing: Promise<void> | undefined;
	#active = 0;
	#drained: (() => void) | undefined;
	private constructor(store: ObjectsStore, owner: string, claimant: Claimant, tables: CommitTables) {
		this.#store = store;
		this.#owner = owner;
		this.#claimant = claimant;
		this.#tables = tables;
		this.#queries = storageQueries(tables);
	}
	static async open(store: Store, owner: string, context: Context): Promise<StoreStorage> {
		const shared = store as ObjectsStore,
			claimant: Claimant = { label: `StoreStorage(${owner})` };
		try {
			const declared = new StoreOwnerTables(shared, owner, claimant),
				tables: CommitTables = {
					recordIds: declared.declare(RecordIds),
					conversations: declared.declare(Conversations),
					entries: declared.declare(Entries),
					entryHeads: declared.declare(EntryHeads),
					tasks: declared.declare(Tasks),
					submissions: declared.declare(Submissions),
				};
			for (const namespace of SCOPE_NAMESPACES) shared.claims.documents(owner, namespace, claimant);
			await declared.prepare(context);
			const highest = await shared.read(
				(executor) =>
					executor.get<{ id: number | null }>(`SELECT max("id") AS id FROM "${tables.recordIds.sql.table}"`),
				context,
			);
			if (highest?.id != null) shared.ids.raise(highest.id);
			return new StoreStorage(shared, owner, claimant, tables);
		} catch (error) {
			shared.claims.release(claimant);
			throw error;
		}
	}
	commit(
		batches: readonly (readonly T.StorageWrite[])[],
		receive: (index: number, seq: T.Seq) => void,
		context: Context,
	): Promise<T.CommitResult> {
		return this.#call(() => {
			const commits: SeriesCommit[] = [];
			for (const writes of batches) {
				try {
					commits.push(
						new DurableCommit(writes, this.#owner, this.#tables, (id) => this.#store.ids.raise(id), context),
					);
				} catch (error) {
					commits.push({
						check: async () => {
							throw error;
						},
						writes: [],
					});
					break;
				}
			}
			return this.#store.commitSeries(commits, (index, seq) => receive(index, seqFromNumber(seq)), context);
		});
	}
	publishing(publish: () => void, context: Context): void {
		if (this.#store.batch) this.#store.batch.within(publish, context);
		else publish();
	}
	mintId<I extends T.Id<string>>(): Promise<I> {
		return this.#call(async () => idFromNumber<I>(this.#store.mintId()));
	}
	conversation(id: T.ConversationId, context: Context): Promise<T.ConversationRecord | undefined> {
		return this.#read((executor) => this.#conversation(executor, id, context), context);
	}
	scanConversations(
		query: T.ConversationQuery,
		limit: number,
		cursor: T.Cursor | undefined,
		context: Context,
	): Promise<T.Page<T.ConversationRecord, T.Cursor>> {
		return this.#reading(() => {
			const start = scanPosition(query.order, cursor, "ascending"),
				conditions: Condition[] = [scanFrom(start)];
			if (query.ownerConversationId !== undefined)
				conditions.push(["owner_conversation_id", "eq", query.ownerConversationId]);
			if (query.ownerTaskId !== undefined) conditions.push(["owner_task_id", "eq", query.ownerTaskId]);
			return this.#scan(this.#queries.conversations, conditions, start, limit, context);
		});
	}
	entry(id: T.EntryId, context: Context): Promise<Entry | undefined>;
	entry(conversationId: T.ConversationId, id: T.EntryId, context: Context): Promise<Entry | undefined>;
	entry(
		first: T.EntryId | T.ConversationId,
		second: T.EntryId | Context,
		context?: Context,
	): Promise<Entry | undefined> {
		if (context === undefined)
			return this.#read((executor) => this.#entry(executor, first as T.EntryId, second as Context), second as Context);
		return this.#reading(() => {
			if (typeof second !== "number") throw new StorageRequestError("Storage.entry() requires an entry ID");
			return this.#store
				.read((executor) => this.#visibleEntry(executor, first as T.ConversationId, second, context), context)
				.then(told);
		});
	}
	findLatestHeadMarker(
		conversationId: T.ConversationId,
		atOrBeforeEntryId: T.EntryId | undefined,
		context: Context,
	): Promise<(T.EntryRecord & { readonly head: T.EntryId }) | undefined> {
		return this.#reading(() =>
			this.#store
				.read((executor) => this.#head(executor, conversationId, atOrBeforeEntryId, context), context)
				.then(told),
		);
	}
	scanEntries(
		query: T.EntryQuery,
		limit: number,
		cursor: T.Cursor | undefined,
		context: Context,
	): Promise<T.Page<T.EntryRecord, T.Cursor>> {
		return this.#reading(() => {
			const start = scanPosition(query.order, cursor, "descending");
			return this.#store.read((executor) => this.#entries(executor, query, limit, start, context), context).then(told);
		});
	}
	task(id: T.TaskId, context: Context): Promise<Task | undefined> {
		return this.#read((executor) => this.#record<Task>(this.#queries.tasks, executor, id, context), context);
	}
	scanTasks(
		query: T.TaskQuery,
		limit: number,
		cursor: T.Cursor | undefined,
		context: Context,
	): Promise<T.Page<Task, T.Cursor>> {
		return this.#reading(() => {
			const start = scanPosition(query.order, cursor, "ascending"),
				conditions: Condition[] = [scanFrom(start)];
			if (query.conversationId !== undefined) conditions.push(["conversation_id", "eq", query.conversationId]);
			if (query.kind !== undefined) conditions.push(["kind", "eq", encodeIndexed(query.kind)]);
			if (query.status !== undefined) conditions.push(["status", "eq", query.status]);
			if (query.abortRequested !== undefined) conditions.push(["abort_requested", "eq", Number(query.abortRequested)]);
			if (query.background !== undefined) conditions.push(["background", "eq", Number(query.background)]);
			return this.#scan(this.#queries.tasks, conditions, start, limit, context);
		});
	}
	submission(id: T.SubmissionId, context: Context): Promise<T.SubmissionRecord | undefined> {
		return this.#read(
			(executor) => this.#record<T.SubmissionRecord>(this.#queries.submissions, executor, id, context),
			context,
		);
	}
	scanSubmissions(
		query: T.SubmissionQuery,
		limit: number,
		cursor: T.Cursor | undefined,
		context: Context,
	): Promise<T.Page<T.SubmissionRecord, T.Cursor>> {
		return this.#reading(() => {
			const start = scanPosition(query.order, cursor, "ascending"),
				conditions: Condition[] = [scanFrom(start)];
			if (query.conversationId !== undefined) conditions.push(["conversation_id", "eq", query.conversationId]);
			if (query.status !== undefined) conditions.push(["status", "eq", query.status]);
			return this.#scan(this.#queries.submissions, conditions, start, limit, context);
		});
	}
	submissionByRequest(
		conversationId: T.ConversationId,
		requestId: string,
		context: Context,
	): Promise<T.SubmissionRecord | undefined> {
		return this.#read(async (executor) => {
			const row = await this.#queries.submissions.first(
				executor,
				[
					["conversation_id", "eq", conversationId],
					["request_id", "eq", encodeIndexed(requestId)],
				],
				"ascending",
			);
			return row === undefined ? undefined : this.#queries.submissions.record<T.SubmissionRecord>(row, context);
		}, context);
	}
	findDocument(
		address: T.DocumentAddress,
		at: T.DocumentPoint,
		context: Context,
	): Promise<T.DocumentRecord | undefined> {
		return this.#read(async (executor) => {
			const entry = await findDocumentEntry(executor, addressOf(address, this.#owner), at);
			return entry === undefined ? undefined : recordOfEntry(entry);
		}, context);
	}
	document(id: T.DocumentId, at: T.DocumentPoint, context: Context): Promise<T.StoredDocument | undefined> {
		return this.#reading(() =>
			this.#store.readTransaction((executor) => readAt(executor, id, at, this.#owner), context).then(documentOf),
		);
	}
	scanDocuments(
		query: T.DocumentQuery,
		limit: number,
		cursor: T.Cursor | undefined,
		context: Context,
	): Promise<T.Page<T.DocumentRecord, T.Cursor>> {
		return this.#reading(() => {
			const after = cursor?.after;
			if (after !== undefined && (typeof after !== "number" || !Number.isSafeInteger(after)))
				throw new StorageRequestError("Invalid storage cursor");
			const scope = {
				owner: this.#owner,
				namespace: namespaceOf(query.scope),
				...(query.kind === undefined ? {} : { kind: encodeIndexed(query.kind) }),
			};
			return this.#store
				.read((executor) => listDocumentEntries(executor, scope, query.at, after ?? -1, limit + 1), context)
				.then((rows) => page(rows.map(recordOfEntry), limit, "ascending"));
		});
	}
	close(_context: Context): Promise<void> {
		if (!this.#closing) {
			this.#closed = true;
			this.#closing = (async () => {
				if (this.#active)
					await new Promise<void>((resolve) => {
						this.#drained = resolve;
					});
				this.#store.claims.release(this.#claimant);
			})();
		}
		return this.#closing;
	}
	async #call<Value>(work: () => Promise<Value>): Promise<Value> {
		if (this.#closed) throw new Error("StoreStorage is closed");
		this.#active++;
		try {
			return await work();
		} finally {
			this.#active--;
			if (!this.#active) this.#drained?.();
		}
	}
	#reading<Value>(work: () => Promise<Value>): Promise<Value> {
		try {
			if (this.#closed) throw new Error("StoreStorage is closed");
			return work();
		} catch (error) {
			return Promise.reject(error);
		}
	}
	#read<Value>(read: (executor: SqliteExecutor) => Promise<Value>, context: Context): Promise<Value> {
		return this.#reading(() => this.#store.read(read, context));
	}
	async #record<Value>(
		queries: TableQueries,
		executor: SqliteExecutor,
		id: number,
		context: Context,
	): Promise<Value | undefined> {
		const row = await queries.byId(executor, id);
		return row === undefined ? undefined : queries.record<Value>(row, context);
	}
	#conversation(
		executor: SqliteExecutor,
		id: T.ConversationId,
		context: Context,
	): Promise<T.ConversationRecord | undefined> {
		return this.#record(this.#queries.conversations, executor, id, context);
	}
	async #entry(executor: SqliteExecutor, id: T.EntryId, context: Context): Promise<Entry | undefined> {
		const row = await this.#queries.entries.byId(executor, id);
		return row === undefined
			? undefined
			: {
					entry: this.#queries.entries.record<T.EntryRecord>(row, context),
					commitSeq: seqFromNumber(row.commit_seq!),
				};
	}
	async #visibleEntry(
		executor: SqliteExecutor,
		conversationId: T.ConversationId,
		id: T.EntryId,
		context: Context,
	): Promise<Read<Entry | undefined>> {
		let conversation = await this.#conversation(executor, conversationId, context);
		if (!conversation) return unknownConversation(conversationId);
		const entry = await this.#entry(executor, id, context);
		if (!entry) return notFound;
		let upper = Infinity;
		while (conversation.id !== entry.entry.conversationId) {
			if (!conversation.parent) return notFound;
			upper = Math.min(upper, conversation.parent.at);
			conversation = (await this.#conversation(executor, conversation.parent.conversationId, context))!;
		}
		return entry.entry.id > upper ? notFound : { kind: "found", value: entry };
	}
	async #head(
		executor: SqliteExecutor,
		conversationId: T.ConversationId,
		at: T.EntryId | undefined,
		context: Context,
	): Promise<Read<(T.EntryRecord & { readonly head: T.EntryId }) | undefined>> {
		let conversation = await this.#conversation(executor, conversationId, context),
			upper: number | undefined = at;
		if (!conversation) return unknownConversation(conversationId);
		for (;;) {
			const queries = this.#queries.latestHead;
			const marker =
				upper === undefined
					? await executor.get<{ id: number }>(queries.any, conversation.id)
					: await executor.get<{ id: number }>(queries.atOrBefore, conversation.id, upper);
			if (marker)
				return {
					kind: "found",
					value: this.#queries.entries.record<T.EntryRecord & { readonly head: T.EntryId }>(
						(await this.#queries.entries.byId(executor, marker.id))!,
						context,
					),
				};
			if (!conversation.parent) return notFound;
			upper = Math.min(upper ?? Infinity, conversation.parent.at);
			conversation = (await this.#conversation(executor, conversation.parent.conversationId, context))!;
		}
	}
	#range(id: T.ConversationId, lower: number | undefined, upper: number | undefined): Condition[] {
		const result: Condition[] = [["conversation_id", "eq", id]];
		if (lower !== undefined) result.push(["id", "gte", lower]);
		if (upper !== undefined) result.push(["id", "lte", upper]);
		return result;
	}
	async #entries(
		executor: SqliteExecutor,
		query: T.EntryQuery,
		limit: number,
		start: Start,
		context: Context,
	): Promise<Read<T.Page<T.EntryRecord, T.Cursor>>> {
		let conversation = await this.#conversation(executor, query.conversationId, context);
		if (!conversation) return unknownConversation(query.conversationId);
		const values: T.EntryRecord[] = [],
			entries = this.#queries.entries;
		let upper: number | undefined = query.maxEntryId;
		if (start.order === "descending") {
			if (start.after !== undefined) upper = Math.min(upper ?? Number.MAX_SAFE_INTEGER, start.after - 1);
			for (;;) {
				entries.records(
					await entries.select(
						executor,
						this.#range(conversation.id, query.minEntryId, upper),
						"descending",
						limit + 1 - values.length,
					),
					values,
					context,
				);
				if (values.length > limit || !conversation.parent) break;
				upper = Math.min(upper ?? Infinity, conversation.parent.at);
				if (query.minEntryId !== undefined && upper < query.minEntryId) break;
				conversation = (await this.#conversation(executor, conversation.parent.conversationId, context))!;
			}
		} else {
			const segments: { id: T.ConversationId; upper: number | undefined }[] = [];
			for (;;) {
				segments.push({ id: conversation.id, upper });
				if (!conversation.parent) break;
				upper = Math.min(upper ?? Infinity, conversation.parent.at);
				if (query.minEntryId !== undefined && upper < query.minEntryId) break;
				conversation = (await this.#conversation(executor, conversation.parent.conversationId, context))!;
			}
			const lower =
				start.after === undefined ? query.minEntryId : Math.max(query.minEntryId ?? start.after + 1, start.after + 1);
			for (let i = segments.length - 1; i >= 0; i--) {
				const segment = segments[i]!;
				entries.records(
					await entries.select(
						executor,
						this.#range(segment.id, lower, segment.upper),
						"ascending",
						limit + 1 - values.length,
					),
					values,
					context,
				);
				if (values.length > limit) break;
			}
		}
		return { kind: "found", value: page(values, limit, start.order) };
	}
	#scan<Value extends { readonly id: T.Id<string> }>(
		queries: TableQueries,
		conditions: readonly Condition[],
		start: Start,
		limit: number,
		context: Context,
	): Promise<T.Page<Value, T.Cursor>> {
		return this.#store
			.read((executor) => queries.select(executor, conditions, start.order, limit + 1), context)
			.then((rows) => {
				const records: Value[] = [];
				queries.records(rows, records, context);
				return page(records, limit, start.order);
			});
	}
}
