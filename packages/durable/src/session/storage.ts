import type { Context, JsonValue } from "@axi/chord";
import { SessionFailed, StorageRequestError } from "../errors.ts";
import type * as T from "../types.ts";
type FailureOwner = { readonly failure: { readonly error: unknown } | undefined; fail(error: unknown): void };
export class GuardedStorage implements T.Storage {
	readonly #backend: T.Storage;
	readonly #owner: FailureOwner;
	readonly #pending = new Set<Promise<unknown>>();
	#closing = false;
	constructor(backend: T.Storage, owner: FailureOwner) {
		this.#backend = backend;
		this.#owner = owner;
	}
	async #call<Value>(context: Context | undefined, operation: () => Promise<Value>): Promise<Value> {
		this.#healthy();
		if (this.#closing) throw new Error("Session is closed");
		const pending = (async () => operation())();
		this.#pending.add(pending);
		let value: Value;
		try {
			value = await pending;
		} catch (error) {
			this.#healthy();
			if (!(context && (error instanceof StorageRequestError || context.abortSignal?.aborted))) this.#owner.fail(error);
			throw error;
		} finally {
			this.#pending.delete(pending);
		}
		this.#healthy();
		return value;
	}
	#healthy(): void {
		const failure = this.#owner.failure;
		if (failure !== undefined) throw new SessionFailed(failure.error);
	}
	commit(writes: readonly T.StorageWrite[], context: Context) {
		return this.#call(undefined, () => this.#backend.commit(writes, context));
	}
	mintId<RecordId extends T.Id<string>>(): Promise<RecordId> {
		return this.#call(undefined, () => this.#backend.mintId<RecordId>());
	}
	conversation(id: T.ConversationId, context: Context) {
		return this.#call(context, () => this.#backend.conversation(id, context));
	}
	scanConversations(query: T.ConversationQuery, limit: number, cursor: T.Cursor | undefined, context: Context) {
		return this.#call(context, () => this.#backend.scanConversations(query, limit, cursor, context));
	}
	entry(
		id: T.EntryId,
		context: Context,
	): Promise<{ readonly entry: T.EntryRecord; readonly commitSeq: T.Seq } | undefined>;
	entry(
		conversation: T.ConversationId,
		id: T.EntryId,
		context: Context,
	): Promise<{ readonly entry: T.EntryRecord; readonly commitSeq: T.Seq } | undefined>;
	entry(first: T.ConversationId | T.EntryId, second: T.EntryId | Context, third?: Context) {
		return third
			? this.#call(third, () => this.#backend.entry(first as T.ConversationId, second as T.EntryId, third))
			: this.#call(second as Context, () => this.#backend.entry(first as T.EntryId, second as Context));
	}
	findLatestHeadMarker(conversation: T.ConversationId, at: T.EntryId | undefined, context: Context) {
		return this.#call(context, () => this.#backend.findLatestHeadMarker(conversation, at, context));
	}
	scanEntries(query: T.EntryQuery, limit: number, cursor: T.Cursor | undefined, context: Context) {
		return this.#call(context, () => this.#backend.scanEntries(query, limit, cursor, context));
	}
	task(id: T.TaskId, context: Context): Promise<T.TaskRecord<JsonValue, JsonValue, JsonValue> | undefined> {
		return this.#call(context, () => this.#backend.task(id, context));
	}
	scanTasks(query: T.TaskQuery, limit: number, cursor: T.Cursor | undefined, context: Context) {
		return this.#call(context, () => this.#backend.scanTasks(query, limit, cursor, context));
	}
	submission(id: T.SubmissionId, context: Context) {
		return this.#call(context, () => this.#backend.submission(id, context));
	}
	scanSubmissions(query: T.SubmissionQuery, limit: number, cursor: T.Cursor | undefined, context: Context) {
		return this.#call(context, () => this.#backend.scanSubmissions(query, limit, cursor, context));
	}
	submissionByRequest(conversation: T.ConversationId, request: string, context: Context) {
		return this.#call(context, () => this.#backend.submissionByRequest(conversation, request, context));
	}
	findDocument(address: T.DocumentAddress, at: T.DocumentPoint, context: Context) {
		return this.#call(context, () => this.#backend.findDocument(address, at, context));
	}
	document(id: T.DocumentId, at: T.DocumentPoint, context: Context) {
		return this.#call(context, () => this.#backend.document(id, at, context));
	}
	scanDocuments(query: T.DocumentQuery, limit: number, cursor: T.Cursor | undefined, context: Context) {
		return this.#call(context, () => this.#backend.scanDocuments(query, limit, cursor, context));
	}
	async close(context: Context): Promise<void> {
		this.#closing = true;
		await Promise.allSettled(this.#pending);
		await this.#backend.close(context);
	}
}
