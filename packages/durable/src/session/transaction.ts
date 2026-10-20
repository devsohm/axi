import { BACKGROUND_CONTEXT } from "@axi/chord/context";
import type { TelemetryCarrier } from "@axi/telemetry";
import { copyJson, type Context, type Draft, type JsonValue } from "@axi/chord";
import { type Change, type Prepared, type Tracker, track } from "@axi/chord/delta";
import {
	addressId,
	checkRecordScope,
	checkRecordVersion,
	documentCreate,
	materializeDocumentValue,
	resolveAddress,
	type AnyDocDefinition,
	type AnyDocToken,
} from "../documents.ts";
import { ReadAfterWrite } from "../errors.ts";
import type * as T from "../types.ts";
import { ROOT_CONVERSATION_ID } from "../types.ts";
import { prepareForkDocumentCopies } from "./forks.ts";

type TaskRecord = T.TaskRecord<JsonValue, JsonValue, JsonValue>;
export type LoadedDocument = {
	readonly addressId: string;
	readonly record: T.DocumentRecord;
	storedVersion: number;
	readonly valueVersion: number;
	deltasSinceBase: number;
	readonly tracker: Tracker<T.JsonObject>;
};
export type TaskCreationOptions = T.TaskOptions & { readonly submissionIds?: readonly T.SubmissionId[] };
export type TransactionScope = { readonly conversationId?: T.ConversationId; readonly taskId?: T.TaskId };
export interface TransactionHost {
	readonly storage: T.Storage;
	now(): number;
	cached(address: string): LoadedDocument | undefined;
	load(
		definition: AnyDocDefinition,
		identity: string,
		address: T.DocumentAddress,
		context: Context,
	): Promise<LoadedDocument | undefined>;
	install(document: LoadedDocument): void;
	evict(address: string, incarnation: T.DocumentId): void;
	conversationCreated(tx: Transaction, record: T.ConversationRecord): Promise<void>;
}
type DocumentTarget =
	| { kind: "existing"; loaded: LoadedDocument }
	| { kind: "new"; record: T.DocumentCreate; version: number; tracker: Tracker<T.JsonObject> }
	| { kind: "copy"; record: T.DocumentCreate; source: T.DocumentCopySource }
	| { kind: "retirement"; record: T.DocumentRecord };
type DocumentEdit = {
	readonly identity: string;
	readonly address: T.DocumentAddress;
	definition?: AnyDocDefinition;
	acquisition?: Promise<Draft<T.JsonObject>>;
	target?: DocumentTarget;
	change?: Change<T.JsonObject>;
	prepared?: Prepared<T.JsonObject>;
	retire: boolean;
};
type ContentWrite = Extract<T.StorageWrite, { type: "document.create" | "document.change" | "document.copy" }>;
type DocumentPlan = {
	readonly identity: string;
	readonly record: T.DocumentCreate | T.DocumentRecord;
	retire: boolean;
	content?: ContentWrite;
	change?: {
		tracker: Tracker<T.JsonObject>;
		prepared: Prepared<T.JsonObject>;
		version: number;
		loaded?: LoadedDocument;
		definition?: AnyDocDefinition;
	};
	conversationId?: T.ConversationId;
};
type TaskEdit = {
	read?: Promise<TaskRecord | undefined>;
	write?: { readonly kind: "create" | "replace"; readonly record: TaskRecord };
};
type SubmissionChange = T.SubmissionSettlement | { readonly status: "placed"; readonly entry: T.EntryId };
function tableCopy<Value>(value: Value): Value {
	return copyJson(value, { omitUndefinedProperties: true }) as Value;
}
function changesValue(plan: DocumentPlan): boolean {
	return plan.retire || !plan.change?.loaded || plan.content !== undefined;
}
export class Transaction implements T.Tx {
	readonly #host: TransactionHost;
	#context: Context;
	readonly #scope: TransactionScope;
	readonly #pending = new Set<Promise<unknown>>();
	readonly #writes: T.StorageWrite[] = [];
	readonly #created = new Set<T.ConversationId>();
	readonly #forkParents = new Set<T.ConversationId>();
	readonly #forkDocuments = new Set<T.DocumentId>();
	readonly #tasks = new Map<T.TaskId, TaskEdit>();
	readonly #submissions = new Map<T.SubmissionId, T.SubmissionRecord>();
	readonly #settlements: { id: T.SubmissionId; change: SubmissionChange }[] = [];
	readonly #edits: DocumentEdit[] = [];
	readonly #latest = new Map<string, DocumentEdit>();
	readonly #plans: DocumentPlan[] = [];
	#sealed = false;
	#written = false;
	constructor(host: TransactionHost, context: Context, scope: TransactionScope = {}) {
		this.#host = host;
		this.#context = context;
		this.#scope = scope;
	}
	conversation(id: T.ConversationId) {
		return this.#read("conversation", () => this.#host.storage.conversation(id, this.#context));
	}
	entry(id: T.EntryId): Promise<T.EntryRecord | undefined>;
	entry<Value extends JsonValue>(token: T.Entry<Value>, id: T.EntryId): Promise<T.TypedEntry<Value> | undefined>;
	entry(first: T.EntryId | { readonly kind: string }, second?: T.EntryId): Promise<T.EntryRecord | undefined> {
		const kind = typeof first === "number" ? undefined : first.kind;
		const id = typeof first === "number" ? first : second!;
		return this.#read("entry", async () => {
			const row = await this.#host.storage.entry(id, this.#context);
			return kind === undefined || row?.entry.kind === kind ? row?.entry : undefined;
		});
	}
	task(id: T.TaskId) {
		return this.#read("task", () => this.#committedTask(id));
	}
	scanConversations(query: T.ConversationQuery, limit: number, cursor?: T.Cursor) {
		return this.#read("scanConversations", () =>
			this.#host.storage.scanConversations(query, limit, cursor, this.#context),
		);
	}
	scanEntries(query: T.EntryQuery, limit: number, cursor?: T.Cursor) {
		return this.#read("scanEntries", () => this.#host.storage.scanEntries(query, limit, cursor, this.#context));
	}
	scanTasks(query: T.TaskQuery, limit: number, cursor?: T.Cursor) {
		return this.#read("scanTasks", () => this.#host.storage.scanTasks(query, limit, cursor, this.#context));
	}
	latestHeadMarker(conversationId: T.ConversationId) {
		return this.#read("latestHeadMarker", () =>
			this.#host.storage.findLatestHeadMarker(conversationId, undefined, this.#context),
		);
	}
	submission(id: T.SubmissionId) {
		return this.#read("submission", () => this.#host.storage.submission(id, this.#context));
	}
	submissionByRequest(conversationId: T.ConversationId, requestId: string) {
		return this.#read("submissionByRequest", () =>
			this.#host.storage.submissionByRequest(conversationId, requestId, this.#context),
		);
	}
	createConversation(options: { readonly ownership: T.ConversationOwnership }): Promise<T.ConversationRecord> {
		return this.#write(() => this.#conversation(undefined, options.ownership));
	}
	createRootConversation(): Promise<T.ConversationRecord> {
		return this.#write(() => this.#conversation(undefined, { kind: "ownerless" }, ROOT_CONVERSATION_ID));
	}
	forkConversation(
		parent: T.ConversationId,
		at: T.EntryId,
		options: { readonly ownership: T.ConversationOwnership },
	): Promise<T.ConversationRecord> {
		return this.#write(() => this.#conversation({ conversationId: parent, at }, options.ownership));
	}
	async #conversation(
		parent: T.ConversationRecord["parent"],
		ownership: T.ConversationOwnership,
		reserved?: T.ConversationId,
	): Promise<T.ConversationRecord> {
		const ownerId = ownership.kind === "task" ? ownership.taskId : undefined;
		const id = reserved ?? (await this.#host.storage.mintId<T.ConversationId>());
		this.#open();
		let owner: T.ConversationRecord["owner"];
		if (ownerId !== undefined) {
			const task = await this.#currentTask(ownerId);
			this.#open();
			if (!task) throw new Error(`Conversation owner task ${ownerId} does not exist`);
			owner = { conversationId: task.conversationId, taskId: ownerId };
		}
		const record = { id, ...(parent ? { parent } : {}), ...(owner ? { owner } : {}) };
		if (parent) {
			const copies = await prepareForkDocumentCopies(
				this.#host.storage,
				parent.conversationId,
				parent.at,
				id,
				this.#context,
			);
			this.#open();
			for (const copy of copies) {
				const edit: DocumentEdit = {
					identity: addressId(copy.record),
					address: copy.record,
					target: { kind: "copy", ...copy },
					retire: false,
				};
				this.#edits.push(edit);
				this.#latest.set(edit.identity, edit);
				this.#forkDocuments.add(copy.source.id);
			}
			this.#forkParents.add(parent.conversationId);
		}
		this.#created.add(id);
		this.#writes.push({ type: "conversation", value: record });
		await this.#host.conversationCreated(this, record);
		this.#open();
		return record;
	}
	appendEntry(conversationId: T.ConversationId, value: T.EntryDraft): Promise<T.EntryRecord>;
	appendEntry<Value extends JsonValue>(
		token: T.Entry<Value>,
		conversationId: T.ConversationId,
		value: T.TypedEntryDraft<NoInfer<Value>>,
	): Promise<T.TypedEntry<Value>>;
	appendEntry(
		first: T.ConversationId | { readonly kind: string },
		second: T.ConversationId | T.EntryDraft,
		third?: object,
	): Promise<T.EntryRecord> {
		const conversationId = typeof first === "number" ? first : (second as T.ConversationId);
		const value =
			typeof first === "number" ? (second as T.EntryDraft) : ({ ...third, kind: first.kind } as T.EntryDraft);
		return this.#write(async () => {
			await this.#requireConversation(conversationId);
			this.#open();
			const id = await this.#host.storage.mintId<T.EntryId>();
			this.#open();
			const { head, ...body } = value;
			const record = tableCopy({
				...body,
				id,
				conversationId,
				head: head === "self" ? id : head,
				byTaskId: this.#scope.taskId,
			});
			this.#writes.push({ type: "entry", value: record });
			return record;
		});
	}
	createTask<I, S extends { phase: string }, R, H extends object>(
		task: T.Task<I, S, R, H>,
		input: I,
		options: TaskCreationOptions,
	): Promise<T.TaskId<R>> {
		return this.#write(async () => {
			if (options.submissionIds !== undefined) {
				let trace: T.TaskOptions["trace"];
				let links: TelemetryCarrier[] | undefined;
				for (const [index, id] of options.submissionIds.entries()) {
					const record = this.#submissions.get(id) ?? (await this.#host.storage.submission(id, this.#context));
					if (index === 0) trace = record?.trace ?? "root";
					else if (record?.trace !== undefined) (links ??= []).push(record.trace);
				}
				options = { ...options, trace, links };
			}
			const ownership = options.ownership;
			let owner: TaskRecord | undefined;
			if (ownership.kind === "task") {
				const ownerId = ownership.taskId;
				owner = await this.#currentTask(ownerId);
				this.#open();
				if (!owner) throw new Error(`Task owner ${ownerId} does not exist`);
				if (options.background === true) throw new TypeError("A child task cannot be background");
				if (options.conversationId !== undefined && options.conversationId !== owner.conversationId)
					throw new Error(`A child task lives in its owner's conversation ${owner.conversationId}`);
			}
			const conversationId = owner?.conversationId ?? options.conversationId ?? this.#scope.conversationId;
			if (conversationId === undefined) throw new TypeError("Tx.createTask() requires options.conversationId");
			await this.#requireConversation(conversationId);
			this.#open();
			const { definition } = task;
			const checkpoint = definition.initial(input);
			const id = await this.#host.storage.mintId<T.TaskId<R>>();
			this.#open();
			const record = copyJson(
				{
					id,
					conversationId,
					kind: definition.name,
					trace:
						options.trace === "root"
							? undefined
							: (options.trace ?? this.#context.telemetry.propagation?.inject(this.#context.telemetry)),
					links: options.links,
					version: definition.version,
					input,
					...(owner ? { owner: owner.id } : {}),
					background: options.background ?? false,
					abortRequested: false,
					...(options.abandonOnRestart === true ? { abandonOnRestart: true } : {}),
					state: { status: "pending", checkpoint },
				},
				{ omitUndefinedProperties: true },
			) as unknown as TaskRecord;
			this.#taskEdit(id).write = { kind: "create", record };
			return id;
		});
	}
	createSubmission(create: T.SubmissionCreate): Promise<T.SubmissionRecord> {
		return this.#write(async () => {
			await this.#requireConversation(create.conversationId);
			this.#open();
			const id = await this.#host.storage.mintId<T.SubmissionId>();
			this.#open();
			const record: T.SubmissionRecord = tableCopy({ ...create, id });
			this.#submissions.set(id, record);
			return record;
		});
	}
	settleSubmission(id: T.SubmissionId, settlement: T.SubmissionSettlement): void {
		this.#open();
		this.#written = true;
		this.#settlements.push({ id, change: copyJson(settlement) as T.SubmissionSettlement });
	}
	placeSubmission(id: T.SubmissionId, entry: T.EntryId): void {
		this.#open();
		this.#written = true;
		this.#settlements.push({ id, change: { status: "placed", entry } });
	}
	setTask(value: TaskRecord): void {
		this.#open();
		this.#written = true;
		const edit = this.#taskEdit(value.id);
		const previous = edit.write?.record;
		if (previous?.state.status === "terminal") throw new Error(`Task ${value.id} already has a terminal candidate`);
		if (previous && previous.conversationId !== value.conversationId)
			throw new Error(`Task ${value.id} cannot change conversations`);
		const startedAt =
			previous?.startedAt ?? value.startedAt ?? (value.state.status === "running" ? this.#host.now() : undefined);
		const endedAt =
			previous?.endedAt ?? value.endedAt ?? (value.state.status === "terminal" ? this.#host.now() : undefined);
		edit.write = {
			kind: edit.write?.kind ?? "replace",
			record: tableCopy({
				...value,
				...(startedAt === undefined ? {} : { startedAt }),
				...(endedAt === undefined ? {} : { endedAt }),
			}),
		};
	}
	stagedTasks(): TaskRecord[] {
		return [...this.#tasks.values()].flatMap((edit) => (edit.write ? [edit.write.record] : []));
	}
	stagedConversations(): T.ConversationRecord[] {
		return this.#writes.flatMap((write) => (write.type === "conversation" ? [write.value] : []));
	}
	doc<Value extends T.JsonObject>(token: T.SessionDocToken<Value>): Promise<Draft<Value>>;
	doc<Value extends T.JsonObject, Seed extends JsonValue>(
		token: T.SessionDocFamilyToken<Value, Seed>,
		key: string,
		seed: Seed,
	): Promise<Draft<Value>>;
	doc<Value extends T.JsonObject>(
		token: T.ConversationDocToken<Value>,
		conversationId: T.ConversationId,
	): Promise<Draft<Value>>;
	doc<Value extends T.JsonObject, Seed extends JsonValue>(
		token: T.ConversationDocFamilyToken<Value, Seed>,
		conversationId: T.ConversationId,
		key: string,
		seed: Seed,
	): Promise<Draft<Value>>;
	doc<Value extends T.JsonObject>(token: T.TaskDocToken<Value>, taskId: T.TaskId): Promise<Draft<Value>>;
	doc<Value extends T.JsonObject, Seed extends JsonValue>(
		token: T.TaskDocFamilyToken<Value, Seed>,
		taskId: T.TaskId,
		key: string,
		seed: Seed,
	): Promise<Draft<Value>>;
	doc(token: AnyDocToken, ...args: readonly unknown[]): Promise<Draft<T.JsonObject>> {
		try {
			this.#open();
			const definition = token.definition;
			const resolved = resolveAddress(definition, args);
			const scope = resolved.address.scope;
			if (scope.kind === "task" && this.#tasks.get(scope.taskId)?.write?.record.state.status === "terminal")
				throw new Error(`Task ${scope.taskId} is terminal`);
			const previous = this.#latest.get(resolved.id);
			if (previous && !previous.retire) {
				if (previous.acquisition) return previous.acquisition;
				if (previous.target?.kind === "copy") {
					previous.acquisition = this.#track(this.#acquireCopy(previous, definition, previous.target));
					return previous.acquisition;
				}
			}
			const seed = definition.family ? copyJson(args[resolved.nextArgument]) : undefined;
			const edit: DocumentEdit = { identity: resolved.id, address: resolved.address, definition, retire: false };
			this.#edits.push(edit);
			this.#latest.set(edit.identity, edit);
			edit.acquisition = this.#track(this.#acquire(edit, definition, seed, previous?.retire === true));
			return edit.acquisition;
		} catch (error) {
			return Promise.reject(error);
		}
	}
	retireDoc<Value extends T.JsonObject>(token: T.SessionDocToken<Value>): Promise<void>;
	retireDoc<Value extends T.JsonObject, Seed extends JsonValue>(
		token: T.SessionDocFamilyToken<Value, Seed>,
		key: string,
	): Promise<void>;
	retireDoc<Value extends T.JsonObject>(
		token: T.ConversationDocToken<Value>,
		conversationId: T.ConversationId,
	): Promise<void>;
	retireDoc<Value extends T.JsonObject, Seed extends JsonValue>(
		token: T.ConversationDocFamilyToken<Value, Seed>,
		conversationId: T.ConversationId,
		key: string,
	): Promise<void>;
	retireDoc<Value extends T.JsonObject>(token: T.TaskDocToken<Value>, taskId: T.TaskId): Promise<void>;
	retireDoc<Value extends T.JsonObject, Seed extends JsonValue>(
		token: T.TaskDocFamilyToken<Value, Seed>,
		taskId: T.TaskId,
		key: string,
	): Promise<void>;
	retireDoc(token: AnyDocToken, ...args: readonly unknown[]): Promise<void> {
		try {
			this.#open();
			const definition = token.definition;
			const resolved = resolveAddress(definition, args);
			const previous = this.#latest.get(resolved.id);
			if (previous?.retire) return Promise.resolve();
			if (previous?.target?.kind === "copy") {
				checkRecordScope(definition, previous.target.record);
				previous.retire = true;
				return Promise.resolve();
			}
			if (previous?.acquisition) {
				previous.retire = true;
				return this.#track(previous.acquisition.then(() => undefined));
			}
			const edit: DocumentEdit = { identity: resolved.id, address: resolved.address, definition, retire: true };
			this.#edits.push(edit);
			this.#latest.set(edit.identity, edit);
			return this.#track(
				(async () => {
					const record =
						this.#host.cached(edit.identity)?.record ??
						(await this.#host.storage.findDocument(edit.address, "current", this.#context));
					this.#open();
					if (record) {
						checkRecordScope(definition, record);
						edit.target = { kind: "retirement", record };
					}
				})(),
			);
		} catch (error) {
			return Promise.reject(error);
		}
	}
	async #acquire(
		edit: DocumentEdit,
		definition: AnyDocDefinition,
		seed: JsonValue | undefined,
		fresh: boolean,
	): Promise<Draft<T.JsonObject>> {
		const loaded = fresh ? undefined : await this.#host.load(definition, edit.identity, edit.address, this.#context);
		this.#open();
		if (loaded) {
			checkRecordScope(definition, loaded.record);
			checkRecordVersion(definition, loaded.record, loaded.storedVersion);
			edit.target = { kind: "existing", loaded };
			edit.change = loaded.tracker.beginChange();
		} else {
			const scope = edit.address.scope;
			if (scope.kind === "conversation") await this.#requireConversation(scope.conversationId);
			if (scope.kind === "task") {
				const task = await this.#currentTask(scope.taskId);
				if (!task) throw new Error(`Task ${scope.taskId} does not exist`);
				if (task.state.status === "terminal") throw new Error(`Task ${scope.taskId} is terminal`);
			}
			this.#open();
			const value = copyJson(definition.family ? definition.initial(seed) : definition.initial()) as T.JsonObject;
			const id = await this.#host.storage.mintId<T.DocumentId>();
			this.#open();
			const tracker = track(value);
			edit.target = {
				kind: "new",
				record: documentCreate(definition, edit.address, id),
				version: definition.version,
				tracker,
			};
			edit.change = tracker.beginChange();
		}
		return edit.change.state;
	}
	async #acquireCopy(
		edit: DocumentEdit,
		definition: AnyDocDefinition,
		target: Extract<DocumentTarget, { kind: "copy" }>,
	): Promise<Draft<T.JsonObject>> {
		const stored = await this.#host.storage.document(target.source.id, target.source.at, this.#context);
		this.#open();
		if (!stored) throw new Error(`Fork source document ${target.source.id} cannot be read`);
		const original = stored.record;
		if (
			original.scope.kind !== "conversation" ||
			original.kind !== target.record.kind ||
			original.key !== target.record.key ||
			original.history !== target.record.history ||
			original.fork !== target.record.fork
		)
			throw new Error(`Fork source document ${target.source.id} does not match the copied record`);
		const tracker = track(materializeDocumentValue(definition, target.record, stored.version, stored.value));
		edit.definition = definition;
		edit.target = { kind: "new", record: target.record, version: definition.version, tracker };
		edit.change = tracker.beginChange();
		return edit.change.state;
	}
	async settleFailure(): Promise<void> {
		this.#sealed = true;
		this.discard();
		await Promise.allSettled(this.#pending);
		this.#context = BACKGROUND_CONTEXT;
	}
	async settleSuccess(): Promise<readonly T.StorageWrite[]> {
		this.#sealed = true;
		if (this.#pending.size) {
			this.discard();
			await Promise.allSettled(this.#pending);
			this.#context = BACKGROUND_CONTEXT;
			throw new Error("Session commit callback settled before its pending Tx operations");
		}
		try {
			for (const edit of this.#edits) if (edit.change) edit.prepared = edit.change.prepare();
			return await this.#assemble();
		} catch (error) {
			this.discard();
			throw error;
		} finally {
			this.#context = BACKGROUND_CONTEXT;
		}
	}
	discard(): void {
		for (const edit of this.#edits) edit.change?.abort();
	}
	async #assemble(): Promise<readonly T.StorageWrite[]> {
		for (const edit of this.#edits) {
			const plan = documentPlan(edit);
			if (plan) this.#plans.push(plan);
		}
		for (const plan of this.#plans) {
			if (!plan.content && !plan.retire) continue;
			if (this.#forkDocuments.has(plan.record.id))
				throw new Error(`Cannot change fork source document ${plan.record.id} in the fork transaction`);
			if (
				plan.record.scope.kind === "conversation" &&
				plan.record.fork === "current" &&
				this.#forkParents.has(plan.record.scope.conversationId)
			)
				throw new Error(
					`Cannot fork conversation ${plan.record.scope.conversationId} while changing its current-policy documents`,
				);
		}
		for (const write of this.#writes) {
			if (write.type !== "conversation" || !write.value.owner) continue;
			const id = write.value.owner.taskId;
			const owner = await this.#currentTask(id);
			if (!owner) throw new Error(`Conversation owner task ${id} does not exist`);
			if (owner.state.status === "completing" || owner.state.status === "terminal")
				throw new Error(`Conversation owner task ${id} is ${owner.state.status}`);
			if (owner.abortRequested) throw new Error(`Conversation owner task ${id} is abort-marked`);
		}
		for (const edit of this.#tasks.values()) {
			if (edit.write?.kind !== "create" || edit.write.record.owner === undefined) continue;
			const id = edit.write.record.owner;
			const owner = await this.#currentTask(id);
			if (!owner) throw new Error(`Task owner ${id} does not exist`);
			if (owner.state.status === "completing" || owner.state.status === "terminal")
				throw new Error(`Task owner ${id} is ${owner.state.status}`);
			if (owner.abortRequested) throw new Error(`Task owner ${id} is abort-marked`);
		}
		const terminal = new Set<T.TaskId>();
		for (const [id, edit] of this.#tasks) {
			if (!edit.write) continue;
			if (edit.write.kind === "replace") {
				const previous = await this.#committedTask(id);
				if (!previous) throw new Error(`Task ${id} does not exist`);
				if (previous.state.status === "terminal") throw new Error(`Task ${id} is already terminal`);
				if (previous.conversationId !== edit.write.record.conversationId)
					throw new Error(`Task ${id} cannot change conversations`);
			}
			if (edit.write.record.state.status === "terminal") terminal.add(id);
		}
		if (terminal.size) {
			const retiring = new Set<T.DocumentId>();
			for (const plan of this.#plans) {
				const scope = plan.record.scope;
				if (scope.kind === "task" && terminal.has(scope.taskId)) {
					plan.retire = true;
					retiring.add(plan.record.id);
				}
			}
			for (const taskId of terminal) {
				if (this.#tasks.get(taskId)?.write?.kind === "create") continue;
				let cursor: T.Cursor | undefined;
				do {
					const page = await this.#host.storage.scanDocuments(
						{ scope: { kind: "task", taskId }, at: "current" },
						256,
						cursor,
						this.#context,
					);
					for (const record of page.items) {
						if (retiring.has(record.id)) continue;
						this.#plans.push({ identity: addressId(record), record, retire: true });
						retiring.add(record.id);
					}
					cursor = page.next;
				} while (cursor !== undefined);
			}
		}
		for (const plan of this.#plans) {
			if (!changesValue(plan)) continue;
			const scope = plan.record.scope;
			if (scope.kind === "conversation") plan.conversationId = scope.conversationId;
			if (scope.kind === "task") plan.conversationId = (await this.#currentTask(scope.taskId))?.conversationId;
		}
		for (const { id, change } of this.#settlements) {
			const current = this.#submissions.get(id) ?? (await this.#host.storage.submission(id, this.#context));
			if (!current) throw new Error(`Submission ${id} does not exist`);
			if (current.status === "done" || current.status === "unanswered") continue;
			if (change.status === "placed" && current.status !== "queued") throw new Error(`Submission ${id} is not queued`);
			if (change.status === "done" && current.status !== "placed")
				throw new Error(`Submission ${id} is not a placed input`);
			const next =
				change.status === "placed"
					? { ...current, status: current.type === "input" ? "placed" : "done", entry: change.entry }
					: { ...current, ...change };
			this.#submissions.set(id, next as T.SubmissionRecord);
		}
		for (const value of this.#submissions.values()) this.#writes.push({ type: "submission", value });
		for (const edit of this.#tasks.values())
			if (edit.write) this.#writes.push({ type: "task", value: edit.write.record });
		for (const plan of this.#plans) {
			const change = plan.change;
			if (plan.content?.type === "document.change" && plan.content.content.kind === "delta" && change?.loaded) {
				if (
					change.definition?.checkpointWhen(change.prepared.value, change.prepared.ops, {
						deltasSinceBase: change.loaded.deltasSinceBase,
					})
				)
					plan.content = {
						type: "document.change",
						id: plan.record.id,
						content: { kind: "base", version: change.version, value: change.prepared.value },
					};
			}
			if (plan.content) this.#writes.push(plan.content);
			if (plan.retire) this.#writes.push({ type: "document.retire", id: plan.record.id });
		}
		return this.#writes;
	}
	adopt(seq: T.Seq): T.DocumentCommitChange[] {
		const changes: T.DocumentCommitChange[] = [];
		for (const plan of this.#plans) {
			const existing = "createdAt" in plan.record;
			let record: T.DocumentRecord = existing ? plan.record : { ...plan.record, createdAt: seq };
			if (plan.retire) record = { ...record, retiredAt: seq };
			const change = plan.change;
			if (change) {
				const { loaded, tracker, prepared, version } = change;
				if (loaded ? prepared.ops.length > 0 : !plan.retire) tracker.adopt(prepared);
				else prepared.abort();
				if (loaded) {
					loaded.storedVersion = Math.max(loaded.storedVersion, version);
					if (plan.content?.type === "document.change")
						loaded.deltasSinceBase = plan.content.content.kind === "base" ? 0 : loaded.deltasSinceBase + 1;
				} else if (!plan.retire)
					this.#host.install({
						addressId: plan.identity,
						record,
						storedVersion: version,
						valueVersion: version,
						deltasSinceBase: 0,
						tracker,
					});
			}
			if (plan.retire) {
				if (existing) this.#host.evict(plan.identity, record.id);
				changes.push({
					type: "document",
					record,
					conversationId: plan.conversationId,
					version: undefined,
					value: null,
					ops: [],
				});
			} else if (plan.content?.type === "document.copy") {
				if (record.scope.kind !== "conversation") throw new Error("Copied document must belong to a conversation");
				changes.push({
					type: "document.copy",
					record,
					conversationId: record.scope.conversationId,
					source: plan.content.source,
				});
			} else if (change && changesValue(plan))
				changes.push({
					type: "document",
					record,
					conversationId: plan.conversationId,
					version: change.version,
					value: change.prepared.value,
					ops: change.loaded ? change.prepared.ops : [],
				});
		}
		return changes;
	}
	#open(): void {
		if (this.#sealed) throw new Error("Transaction has settled");
	}
	#track<Value>(operation: Promise<Value>): Promise<Value> {
		this.#pending.add(operation);
		const settled = () => {
			this.#pending.delete(operation);
		};
		operation.then(settled, settled);
		return operation;
	}
	#read<Value>(method: string, operation: () => Promise<Value>): Promise<Value> {
		try {
			this.#open();
			if (this.#written) throw new ReadAfterWrite(method);
			return this.#track(operation());
		} catch (error) {
			return Promise.reject(error);
		}
	}
	#write<Value>(operation: () => Promise<Value>): Promise<Value> {
		try {
			this.#open();
			this.#written = true;
			return this.#track(operation());
		} catch (error) {
			return Promise.reject(error);
		}
	}
	async #requireConversation(id: T.ConversationId): Promise<void> {
		if (!this.#created.has(id) && !(await this.#host.storage.conversation(id, this.#context)))
			throw new Error(`Conversation ${id} does not exist`);
	}
	#taskEdit(id: T.TaskId): TaskEdit {
		let edit = this.#tasks.get(id);
		if (!edit) {
			edit = {};
			this.#tasks.set(id, edit);
		}
		return edit;
	}
	#committedTask(id: T.TaskId): Promise<TaskRecord | undefined> {
		const edit = this.#taskEdit(id);
		return (edit.read ??= this.#host.storage.task(id, this.#context));
	}
	async #currentTask(id: T.TaskId): Promise<TaskRecord | undefined> {
		return this.#tasks.get(id)?.write?.record ?? (await this.#committedTask(id));
	}
}
function documentPlan(edit: DocumentEdit): DocumentPlan | undefined {
	const target = edit.target;
	if (!target) return undefined;
	const identity = edit.identity;
	const retire = edit.retire;
	if (target.kind === "retirement") return { identity, retire, record: target.record };
	if (target.kind === "copy")
		return {
			identity,
			retire,
			record: target.record,
			content: { type: "document.copy", record: target.record, source: target.source },
		};
	const prepared = edit.prepared!;
	if (target.kind === "new")
		return {
			identity,
			retire,
			record: target.record,
			content: {
				type: "document.create",
				record: target.record,
				content: { kind: "base", version: target.version, value: prepared.value },
			},
			change: { tracker: target.tracker, prepared, version: target.version },
		};
	const loaded = target.loaded;
	const definition = edit.definition!;
	const version = definition.version;
	const content: ContentWrite | undefined =
		loaded.storedVersion < version
			? { type: "document.change", id: loaded.record.id, content: { kind: "base", version, value: prepared.value } }
			: prepared.ops.length
				? { type: "document.change", id: loaded.record.id, content: { kind: "delta", version, ops: prepared.ops } }
				: undefined;
	return {
		identity,
		retire,
		record: loaded.record,
		content,
		change: { tracker: loaded.tracker, prepared, version, loaded, definition },
	};
}
