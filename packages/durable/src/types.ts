import type { WatchHandle } from "@axi/chord";
import type { TelemetryCarrier } from "@axi/telemetry";
import type { Context, Draft, JsonValue } from "@axi/chord";
import type { Op } from "@axi/chord/delta";
import type { Message, Models } from "@axi/ai";
import type { ExecutionEnv } from "./env/index.ts";
import type {
	Agent,
	ContextView,
	ConversationHandle,
	RegistrySnapshot,
	Settings,
	SettledTask,
} from "./harness/types.ts";

declare const recordId: unique symbol;
declare const commitSequence: unique symbol;
export type Id<Kind extends string, Value = unknown> = number & {
	readonly [recordId]: { readonly kind: Kind; readonly type: Value };
};
export type ConversationId = Id<"conversation">;
export type EntryId = Id<"entry">;
export type TaskId<Value = unknown> = Id<"task", Value>;
export type SubmissionId = Id<"submission">;
export type DocumentId = Id<"document">;
export type Seq = number & { readonly [commitSequence]: "sequence" };
export const ROOT_CONVERSATION_ID = 1 as ConversationId;
export type JsonObject = { [key: string]: JsonValue };

export type LatestConversationSemantics = {
	readonly scope: "conversation";
	readonly history: "latest";
	readonly fork: "current" | "initial";
};
export type RewindableConversationSemantics = {
	readonly scope: "conversation";
	readonly history: "rewindable";
	readonly fork: "asOf" | "current" | "initial";
};
export type DocumentSemantics =
	| LatestConversationSemantics
	| RewindableConversationSemantics
	| { readonly scope: "session"; readonly history?: never; readonly fork?: never }
	| { readonly scope: "task"; readonly history?: never; readonly fork?: never };
export type CheckpointInfo = { readonly deltasSinceBase: number };
export type CommonDocDefinition<Value extends JsonObject> = {
	readonly kind: string;
	readonly version: number;
	initial(): Value;
	migrate?(value: JsonObject, fromVersion: number): Value;
	checkpointWhen(value: Readonly<Value>, ops: readonly Op[], info: CheckpointInfo): boolean;
};
export type DocDefinition<Value extends JsonObject> = CommonDocDefinition<Value> & DocumentSemantics;
export type DocFamilyDefinition<Value extends JsonObject, Seed extends JsonValue> = Omit<
	CommonDocDefinition<Value>,
	"initial"
> &
	DocumentSemantics & {
		readonly family: true;
		initial(seed: Seed): Value;
	};
declare const documentValue: unique symbol;
export interface DocToken<Value extends JsonObject, Definition extends DocDefinition<Value>> {
	readonly definition: Definition;
	readonly [documentValue]?: Value;
}
export interface DocFamilyToken<
	Value extends JsonObject,
	Seed extends JsonValue,
	Definition extends DocFamilyDefinition<Value, Seed>,
> {
	readonly definition: Definition;
	readonly [documentValue]?: Value;
}
export type SessionDocToken<Value extends JsonObject> = DocToken<
	Value,
	CommonDocDefinition<Value> & { readonly scope: "session" }
>;
export type ConversationDocToken<Value extends JsonObject> = DocToken<
	Value,
	CommonDocDefinition<Value> & (LatestConversationSemantics | RewindableConversationSemantics)
>;
export type RewindableConversationDocToken<Value extends JsonObject> = DocToken<
	Value,
	CommonDocDefinition<Value> & RewindableConversationSemantics
>;
export type TaskDocToken<Value extends JsonObject> = DocToken<
	Value,
	CommonDocDefinition<Value> & { readonly scope: "task" }
>;
export type SessionDocFamilyToken<Value extends JsonObject, Seed extends JsonValue> = DocFamilyToken<
	Value,
	Seed,
	DocFamilyDefinition<Value, Seed> & { readonly scope: "session" }
>;
export type ConversationDocFamilyToken<Value extends JsonObject, Seed extends JsonValue> = DocFamilyToken<
	Value,
	Seed,
	DocFamilyDefinition<Value, Seed> & (LatestConversationSemantics | RewindableConversationSemantics)
>;
export type RewindableConversationDocFamilyToken<Value extends JsonObject, Seed extends JsonValue> = DocFamilyToken<
	Value,
	Seed,
	DocFamilyDefinition<Value, Seed> & RewindableConversationSemantics
>;
export type TaskDocFamilyToken<Value extends JsonObject, Seed extends JsonValue> = DocFamilyToken<
	Value,
	Seed,
	DocFamilyDefinition<Value, Seed> & { readonly scope: "task" }
>;
export type ConversationOwnership = { readonly kind: "ownerless" } | { readonly kind: "task"; readonly taskId: TaskId };
export type TaskOwnership = { readonly kind: "conversation" } | { readonly kind: "task"; readonly taskId: TaskId };
export type JoinPolicy = "failFast" | "allSettled";

export type RunningTask<I, S, R> = TaskRecord<I, S, R> & {
	readonly state: Extract<TaskState<S, R>, { readonly status: "running" }>;
};
export type NextTaskState<S, R> = Extract<
	TaskState<S, R>,
	{
		readonly status: "running" | "waiting" | "sleeping" | "terminal";
	}
>;
export type PhaseHandler<I, P, S, R, H extends object> = (
	task: RunningTask<I, P, R>,
	runtime: TaskRuntime<I, S, R, H>,
	context: Context,
) => Promise<void>;
export interface HookRunner<H extends object> {
	each<K extends keyof H>(name: K, invoke: (handler: NonNullable<H[K]>) => void | Promise<void>): Promise<void>;
}
export interface TaskRuntime<I, S, R, H extends object> extends DocumentObserver, DocumentReader {
	readonly taskId: TaskId<R>;
	readonly conversationId: ConversationId;
	readonly signal: AbortSignal;
	readonly registry: RegistrySnapshot;
	agent(context: Context): Promise<Agent>;
	readonly settings: Settings;
	readonly models: Models;
	env(context: Context): Promise<ExecutionEnv | undefined>;
	readonly hooks: HookRunner<H>;
	commit(
		change: (
			tx: Tx,
			current: RunningTask<I, S, R>,
		) => NextTaskState<S, R> | undefined | Promise<NextTaskState<S, R> | undefined>,
		context: Context,
	): Promise<void>;
	memo<T extends JsonValue>(name: string, context: Context): Promise<T | undefined>;
	memo<T extends JsonValue>(name: string, candidate: T, context: Context): Promise<T>;
	getTask<T>(id: TaskId<T>, context: Context): Promise<TaskRecord<JsonValue, JsonValue, T> | undefined>;
	waitForTask<T>(id: TaskId<T>, context: Context): Promise<SettledTask<T>>;
	abortOwned(id: TaskId, context: Context): Promise<void>;
	ownedTasks(context: Context): Promise<TaskRecord<JsonValue, JsonValue, JsonValue>[]>;
	outcomes<T>(ids: readonly TaskId<T>[], context: Context): Promise<TaskOutcome<T>[]>;
	conversation(id: ConversationId, context: Context): Promise<ConversationHandle | undefined>;
	entry(id: EntryId, context: Context): Promise<EntryRecord | undefined>;
	entry<D extends JsonValue>(token: Entry<D>, id: EntryId, context: Context): Promise<TypedEntry<D> | undefined>;
	context(conversationId: ConversationId, context: Context, options?: { readonly at?: EntryId }): Promise<ContextView>;
	now(): number;
	setTimer(callback: () => void, delayMs: number): () => void;
	report(error: unknown, from?: ReportFrom): void;
	sleepUntil(until: number, checkpoint: S, context: Context): Promise<void>;
}
export type TaskDefinition<I, S extends { phase: string }, R, H extends object> = {
	readonly name: string;
	readonly version: number;
	initial(input: I): S;
	readonly phases: { readonly [P in S["phase"]]: PhaseHandler<I, Extract<S, { phase: P }>, S, R, H> };
	abort(task: RunningTask<I, S, R>, runtime: TaskRuntime<I, S, R, H>, context: Context): Promise<void>;
	migrate?(input: JsonValue, checkpoint: JsonValue, fromVersion: number): { input: I; checkpoint: S };
	readonly hooks?: H;
};
export interface Task<I, S extends { phase: string }, R, H extends object> {
	readonly definition: TaskDefinition<I, S, R, H>;
}
export type TaskOptions = {
	readonly trace?: TelemetryCarrier | "root";
	readonly links?: readonly TelemetryCarrier[];
	readonly ownership: TaskOwnership;
	readonly conversationId?: ConversationId;
	readonly background?: boolean;
	readonly abandonOnRestart?: boolean;
};

export type ConversationRecord = {
	readonly id: ConversationId;
	readonly parent?: { readonly conversationId: ConversationId; readonly at: EntryId };
	readonly owner?: { readonly conversationId: ConversationId; readonly taskId: TaskId };
};
export type ContextEdit = { readonly target: EntryId } & (
	| { readonly action: "omit"; readonly messages?: never }
	| { readonly action: "replace"; readonly messages: readonly Message[] }
);
export type EntryRecord = {
	readonly id: EntryId;
	readonly conversationId: ConversationId;
	readonly kind: string;
	readonly model?: readonly Message[];
	readonly data?: JsonValue;
	readonly head?: EntryId;
	readonly edits?: readonly ContextEdit[];
	readonly byTaskId?: TaskId;
};
export type EntryDraft = Omit<EntryRecord, "id" | "conversationId" | "byTaskId" | "head"> & {
	readonly head?: EntryId | "self";
};
export type TypedEntry<Value extends JsonValue> = Omit<EntryRecord, "data"> &
	([Value] extends [never] ? { readonly data?: never } : { readonly data: Value });
export type TypedEntryDraft<Value extends JsonValue> = Omit<EntryDraft, "kind" | "data"> &
	([Value] extends [never] ? { readonly data?: never } : { readonly data: Value });
export interface Entry<Value extends JsonValue = never> {
	readonly kind: string;
	is(entry: EntryRecord | undefined): entry is TypedEntry<Value>;
}

type SubmissionIdentity<Kind extends "input" | "write"> = {
	readonly trace?: TelemetryCarrier;
	readonly id: SubmissionId;
	readonly conversationId: ConversationId;
	readonly requestId?: string;
	readonly type: Kind;
};
type QueuedSubmission = {
	readonly status: "queued";
	readonly entry?: never;
	readonly answer?: never;
	readonly reason?: never;
	readonly detail?: never;
};
type InputPlacement = {
	readonly status: "placed";
	readonly entry: EntryId;
	readonly answer?: never;
	readonly reason?: never;
	readonly detail?: never;
};
type AnsweredInput = {
	readonly status: "done";
	readonly entry: EntryId;
	readonly answer: EntryId;
	readonly reason?: never;
	readonly detail?: never;
};
type UnansweredInput = {
	readonly status: "unanswered";
	readonly entry?: EntryId;
	readonly answer?: never;
	readonly reason: string;
	readonly detail?: JsonValue;
};
type WrittenSubmission = {
	readonly status: "done";
	readonly entry: EntryId;
	readonly answer?: never;
	readonly reason?: never;
	readonly detail?: never;
};
export type SubmissionRecord =
	| (SubmissionIdentity<"input"> & (QueuedSubmission | InputPlacement | AnsweredInput | UnansweredInput))
	| (SubmissionIdentity<"write"> &
			(QueuedSubmission | WrittenSubmission | (Omit<UnansweredInput, "entry"> & { readonly entry?: never })));
type OmitVariants<Value, Keys extends PropertyKey> = Value extends unknown ? Omit<Value, Keys> : never;
export type SubmissionCreate = OmitVariants<SubmissionRecord, "id">;
export type SubmissionSettlement =
	| { readonly status: "done"; readonly answer: EntryId }
	| { readonly status: "unanswered"; readonly reason: string; readonly detail?: JsonValue };

export type TaskOutcomeError = { readonly message: string; readonly detail?: JsonValue };
export type ReportTask = { readonly id: TaskId; readonly kind: string; readonly conversationId: ConversationId };
export type HostCallback = "now" | "settings" | "registry" | "env" | "models" | "setTimer" | "onWake";
export type ReportInfo =
	| { readonly type: "session_failed" }
	| {
			readonly type: "task_faulted";
			readonly task: ReportTask;
			readonly extension?: string;
			readonly reason: "threw" | "restart_limit";
	  }
	| { readonly type: "task_parked"; readonly task: ReportTask; readonly extension?: string }
	| { readonly type: "migration_failed"; readonly task: ReportTask; readonly extension?: string }
	| { readonly type: "task_error"; readonly task: ReportTask; readonly extension?: string }
	| {
			readonly type: "task_outdated";
			readonly task: ReportTask;
			readonly extension?: string;
			readonly reason: "missing_task" | "incompatible_task";
	  }
	| {
			readonly type: "extension_error";
			readonly extension?: string;
			readonly task?: ReportTask;
			readonly conversationId?: ConversationId;
	  }
	| { readonly type: "host_error"; readonly callback: HostCallback; readonly task?: ReportTask }
	| { readonly type: "listener_error" };
export type ReportFrom =
	| { readonly type: "extension"; readonly extension?: string }
	| { readonly type: "host"; readonly callback: HostCallback };
export type SetTimer = (
	callback: () => void,
	delayMs: number,
	options: { readonly background: boolean },
) => (() => void) | undefined;
export type TaskOutcome<Value> =
	| { readonly status: "completed"; readonly result: Value; readonly error?: never; readonly reason?: never }
	| { readonly status: "failed"; readonly error: TaskOutcomeError; readonly result?: Value; readonly reason?: never }
	| { readonly status: "aborted"; readonly reason?: string; readonly result?: Value; readonly error?: never }
	| { readonly status: "orphaned"; readonly reason: string; readonly result?: never; readonly error?: never }
	| { readonly status: "faulted"; readonly error: TaskOutcomeError; readonly result?: never; readonly reason?: never };
export type TaskState<Checkpoint, Value> =
	| { readonly status: "pending"; readonly checkpoint: Checkpoint; readonly outcome?: never }
	| { readonly status: "running"; readonly checkpoint: Checkpoint; readonly outcome?: never }
	| { readonly status: "sleeping"; readonly checkpoint: Checkpoint; readonly until: number; readonly outcome?: never }
	| {
			readonly status: "waiting";
			readonly checkpoint: Checkpoint;
			readonly on: readonly TaskId[];
			readonly policy: JoinPolicy;
			readonly outcome?: never;
	  }
	| { readonly status: "completing"; readonly checkpoint?: never; readonly outcome: TaskOutcome<Value> }
	| { readonly status: "terminal"; readonly checkpoint?: never; readonly outcome: TaskOutcome<Value> };
export type TaskRecord<Input, Checkpoint, Value> = {
	readonly trace?: TelemetryCarrier;
	readonly links?: readonly TelemetryCarrier[];
	readonly id: TaskId<Value>;
	readonly conversationId: ConversationId;
	readonly kind: string;
	readonly version: number;
	readonly input: Input;
	readonly owner?: TaskId;
	readonly background: boolean;
	readonly abortRequested: boolean;
	readonly abortReason?: "restart";
	readonly abandonOnRestart?: true;
	readonly startedAt?: number;
	readonly endedAt?: number;
	readonly restarts?: number;
} & (
	| {
			readonly state: Extract<
				TaskState<Checkpoint, Value>,
				{ readonly status: "pending" | "running" | "waiting" | "sleeping" }
			>;
			readonly memos?: Readonly<Record<string, JsonValue>>;
	  }
	| {
			readonly state: Extract<TaskState<Checkpoint, Value>, { readonly status: "completing" | "terminal" }>;
			readonly memos?: never;
	  }
);

type DocumentLocation =
	| { readonly scope: { readonly kind: "session" }; readonly history?: never; readonly fork?: never }
	| {
			readonly scope: { readonly kind: "task"; readonly taskId: TaskId };
			readonly history?: never;
			readonly fork?: never;
	  }
	| ({ readonly scope: { readonly kind: "conversation"; readonly conversationId: ConversationId } } & (
			| Omit<LatestConversationSemantics, "scope">
			| Omit<RewindableConversationSemantics, "scope">
	  ));
export type DocumentRecord = {
	readonly id: DocumentId;
	readonly kind: string;
	readonly key?: string;
	readonly createdAt: Seq;
	readonly retiredAt?: Seq;
} & DocumentLocation;
export type DocumentCreate = OmitVariants<DocumentRecord, "createdAt" | "retiredAt">;
export type DocumentPoint = Seq | "current";
export type DocumentAddress = { readonly kind: string; readonly scope: DocumentRecord["scope"]; readonly key?: string };
export type DocumentQuery = {
	readonly scope: DocumentRecord["scope"];
	readonly at: DocumentPoint;
	readonly kind?: string;
};
export type DocumentContent =
	| { readonly kind: "base"; readonly version: number; readonly value: JsonObject }
	| { readonly kind: "delta"; readonly version: number; readonly ops: readonly Op[] };
export type DocumentCopySource = { readonly id: DocumentId; readonly at: DocumentPoint };
export type StoredDocument = {
	readonly record: DocumentRecord;
	readonly version: number;
	readonly value: JsonObject;
	readonly deltasSinceBase: number;
};

export type ScanOrder = "ascending" | "descending";
export type Cursor = Readonly<Record<string, JsonValue>>;
export type Page<Item, Continuation> = { readonly items: readonly Item[]; readonly next?: Continuation };
export type ConversationQuery = {
	readonly ownerConversationId?: ConversationId;
	readonly ownerTaskId?: TaskId;
	readonly order?: ScanOrder;
};
export type EntryQuery = {
	readonly conversationId: ConversationId;
	readonly minEntryId?: EntryId;
	readonly maxEntryId?: EntryId;
	readonly order?: ScanOrder;
};
export type TaskQuery = {
	readonly conversationId?: ConversationId;
	readonly kind?: string;
	readonly status?: TaskState<JsonValue, JsonValue>["status"];
	readonly abortRequested?: boolean;
	readonly background?: boolean;
	readonly order?: ScanOrder;
};
export type SubmissionQuery = {
	readonly conversationId?: ConversationId;
	readonly status?: SubmissionRecord["status"];
	readonly order?: ScanOrder;
};
export type StorageWrite =
	| { readonly type: "conversation"; readonly value: ConversationRecord }
	| { readonly type: "entry"; readonly value: EntryRecord }
	| { readonly type: "task"; readonly value: TaskRecord<JsonValue, JsonValue, JsonValue> }
	| { readonly type: "submission"; readonly value: SubmissionRecord }
	| {
			readonly type: "document.create";
			readonly record: DocumentCreate;
			readonly content: Extract<DocumentContent, { readonly kind: "base" }>;
	  }
	| { readonly type: "document.copy"; readonly record: DocumentCreate; readonly source: DocumentCopySource }
	| { readonly type: "document.change"; readonly id: DocumentId; readonly content: DocumentContent }
	| { readonly type: "document.retire"; readonly id: DocumentId };

export interface Storage {
	/** Call adopt synchronously after durability and before the next commit. */
	commit(writes: readonly StorageWrite[], adopt: (seq: Seq) => void, context: Context): Promise<Seq>;
	mintId<RecordId extends Id<string>>(): Promise<RecordId>;
	conversation(id: ConversationId, context: Context): Promise<ConversationRecord | undefined>;
	scanConversations(
		query: ConversationQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<ConversationRecord, Cursor>>;
	entry(id: EntryId, context: Context): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined>;
	entry(
		conversationId: ConversationId,
		id: EntryId,
		context: Context,
	): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined>;
	findLatestHeadMarker(
		conversationId: ConversationId,
		atOrBeforeEntryId: EntryId | undefined,
		context: Context,
	): Promise<(EntryRecord & { readonly head: EntryId }) | undefined>;
	scanEntries(
		query: EntryQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<EntryRecord, Cursor>>;
	task(id: TaskId, context: Context): Promise<TaskRecord<JsonValue, JsonValue, JsonValue> | undefined>;
	scanTasks(
		query: TaskQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<TaskRecord<JsonValue, JsonValue, JsonValue>, Cursor>>;
	submission(id: SubmissionId, context: Context): Promise<SubmissionRecord | undefined>;
	scanSubmissions(
		query: SubmissionQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<SubmissionRecord, Cursor>>;
	submissionByRequest(
		conversationId: ConversationId,
		requestId: string,
		context: Context,
	): Promise<SubmissionRecord | undefined>;
	findDocument(address: DocumentAddress, at: DocumentPoint, context: Context): Promise<DocumentRecord | undefined>;
	document(id: DocumentId, at: DocumentPoint, context: Context): Promise<StoredDocument | undefined>;
	scanDocuments(
		query: DocumentQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<DocumentRecord, Cursor>>;
	close(context: Context): Promise<void>;
}

export type DocumentCommitChange =
	| {
			readonly type: "document";
			readonly record: DocumentRecord;
			readonly conversationId: ConversationId | undefined;
			readonly version: number | undefined;
			readonly value: JsonObject | null;
			readonly ops: readonly Op[];
	  }
	| {
			readonly type: "document.copy";
			readonly record: DocumentRecord;
			readonly conversationId: ConversationId;
			readonly source: DocumentCopySource;
	  };
export type TableCommitChange = Extract<
	StorageWrite,
	{ readonly type: "conversation" | "entry" | "task" | "submission" }
>;
export type CommitChange = TableCommitChange | DocumentCommitChange;
export type CommitPublication = { readonly seq: Seq; readonly changes: readonly CommitChange[] };
export type { WatchEnd, WatchHandle } from "@axi/chord";
export type DocumentWatch<Value extends JsonObject> = WatchHandle<Readonly<Value> | null>;
export type SessionEnd = { readonly reason: "closed" } | { readonly reason: "failed"; readonly error: unknown };
export interface DocumentObserver {
	watchDoc<Value extends JsonObject>(
		token: SessionDocToken<Value>,
		context: Context,
	): Promise<DocumentWatch<Value> | undefined>;
	watchDoc<Value extends JsonObject, Seed extends JsonValue>(
		token: SessionDocFamilyToken<Value, Seed>,
		key: string,
		context: Context,
	): Promise<DocumentWatch<Value> | undefined>;
	watchDoc<Value extends JsonObject>(
		token: ConversationDocToken<Value>,
		conversationId: ConversationId,
		context: Context,
	): Promise<DocumentWatch<Value> | undefined>;
	watchDoc<Value extends JsonObject, Seed extends JsonValue>(
		token: ConversationDocFamilyToken<Value, Seed>,
		conversationId: ConversationId,
		key: string,
		context: Context,
	): Promise<DocumentWatch<Value> | undefined>;
	watchDoc<Value extends JsonObject>(
		token: TaskDocToken<Value>,
		taskId: TaskId,
		context: Context,
	): Promise<DocumentWatch<Value> | undefined>;
	watchDoc<Value extends JsonObject, Seed extends JsonValue>(
		token: TaskDocFamilyToken<Value, Seed>,
		taskId: TaskId,
		key: string,
		context: Context,
	): Promise<DocumentWatch<Value> | undefined>;
}
export interface Session extends DocumentObserver {
	readonly closed: Promise<SessionEnd>;
	commit<Value>(change: (tx: Tx) => Value | Promise<Value>, context: Context): Promise<Value>;
	close(context: Context): Promise<void>;
	subscribeCommits(listener: (publication: CommitPublication, context: Context) => void): () => void;
	subscribeClose(listener: () => void): () => void;
	snapshot<Value extends JsonObject>(
		token: SessionDocToken<Value>,
		context: Context,
	): Promise<Readonly<Value> | undefined>;
	snapshot<Value extends JsonObject, Seed extends JsonValue>(
		token: SessionDocFamilyToken<Value, Seed>,
		key: string,
		context: Context,
	): Promise<Readonly<Value> | undefined>;
	snapshot<Value extends JsonObject>(
		token: ConversationDocToken<Value>,
		conversationId: ConversationId,
		context: Context,
	): Promise<Readonly<Value> | undefined>;
	snapshot<Value extends JsonObject, Seed extends JsonValue>(
		token: ConversationDocFamilyToken<Value, Seed>,
		conversationId: ConversationId,
		key: string,
		context: Context,
	): Promise<Readonly<Value> | undefined>;
	snapshot<Value extends JsonObject>(
		token: TaskDocToken<Value>,
		taskId: TaskId,
		context: Context,
	): Promise<Readonly<Value> | undefined>;
	snapshot<Value extends JsonObject, Seed extends JsonValue>(
		token: TaskDocFamilyToken<Value, Seed>,
		taskId: TaskId,
		key: string,
		context: Context,
	): Promise<Readonly<Value> | undefined>;
	snapshotAsOf<Value extends JsonObject>(
		token: RewindableConversationDocToken<Value>,
		conversationId: ConversationId,
		at: EntryId,
		context: Context,
	): Promise<Readonly<Value> | undefined>;
	snapshotAsOf<Value extends JsonObject, Seed extends JsonValue>(
		token: RewindableConversationDocFamilyToken<Value, Seed>,
		conversationId: ConversationId,
		key: string,
		at: EntryId,
		context: Context,
	): Promise<Readonly<Value> | undefined>;
}
export type DocumentReader = Pick<Session, "snapshot" | "snapshotAsOf">;
export interface Tx {
	conversation(id: ConversationId): Promise<ConversationRecord | undefined>;
	entry(id: EntryId): Promise<EntryRecord | undefined>;
	entry<Value extends JsonValue>(token: Entry<Value>, id: EntryId): Promise<TypedEntry<Value> | undefined>;
	task(id: TaskId): Promise<TaskRecord<JsonValue, JsonValue, JsonValue> | undefined>;
	scanConversations(
		query: ConversationQuery,
		limit: number,
		cursor?: Cursor,
	): Promise<Page<ConversationRecord, Cursor>>;
	scanEntries(query: EntryQuery, limit: number, cursor?: Cursor): Promise<Page<EntryRecord, Cursor>>;
	latestHeadMarker(conversationId: ConversationId): Promise<(EntryRecord & { readonly head: EntryId }) | undefined>;
	scanTasks(
		query: TaskQuery,
		limit: number,
		cursor?: Cursor,
	): Promise<Page<TaskRecord<JsonValue, JsonValue, JsonValue>, Cursor>>;
	submissionByRequest(conversationId: ConversationId, requestId: string): Promise<SubmissionRecord | undefined>;
	createConversation(options: { readonly ownership: ConversationOwnership }): Promise<ConversationRecord>;
	forkConversation(
		parentConversationId: ConversationId,
		at: EntryId,
		options: { readonly ownership: ConversationOwnership },
	): Promise<ConversationRecord>;
	appendEntry(conversationId: ConversationId, value: EntryDraft): Promise<EntryRecord>;
	appendEntry<Value extends JsonValue>(
		token: Entry<Value>,
		conversationId: ConversationId,
		value: TypedEntryDraft<NoInfer<Value>>,
	): Promise<TypedEntry<Value>>;
	createSubmission(create: SubmissionCreate): Promise<SubmissionRecord>;
	createTask<I, S extends { phase: string }, R, H extends object>(
		task: Task<I, S, R, H>,
		input: I,
		options: TaskOptions,
	): Promise<TaskId<R>>;
	settleSubmission(id: SubmissionId, settlement: SubmissionSettlement): void;
	placeSubmission(id: SubmissionId, entry: EntryId): void;
	doc<Value extends JsonObject>(token: SessionDocToken<Value>): Promise<Draft<Value>>;
	doc<Value extends JsonObject, Seed extends JsonValue>(
		token: SessionDocFamilyToken<Value, Seed>,
		key: string,
		seed: Seed,
	): Promise<Draft<Value>>;
	doc<Value extends JsonObject>(
		token: ConversationDocToken<Value>,
		conversationId: ConversationId,
	): Promise<Draft<Value>>;
	doc<Value extends JsonObject, Seed extends JsonValue>(
		token: ConversationDocFamilyToken<Value, Seed>,
		conversationId: ConversationId,
		key: string,
		seed: Seed,
	): Promise<Draft<Value>>;
	doc<Value extends JsonObject>(token: TaskDocToken<Value>, taskId: TaskId): Promise<Draft<Value>>;
	doc<Value extends JsonObject, Seed extends JsonValue>(
		token: TaskDocFamilyToken<Value, Seed>,
		taskId: TaskId,
		key: string,
		seed: Seed,
	): Promise<Draft<Value>>;
	retireDoc<Value extends JsonObject>(token: SessionDocToken<Value>): Promise<void>;
	retireDoc<Value extends JsonObject, Seed extends JsonValue>(
		token: SessionDocFamilyToken<Value, Seed>,
		key: string,
	): Promise<void>;
	retireDoc<Value extends JsonObject>(
		token: ConversationDocToken<Value>,
		conversationId: ConversationId,
	): Promise<void>;
	retireDoc<Value extends JsonObject, Seed extends JsonValue>(
		token: ConversationDocFamilyToken<Value, Seed>,
		conversationId: ConversationId,
		key: string,
	): Promise<void>;
	retireDoc<Value extends JsonObject>(token: TaskDocToken<Value>, taskId: TaskId): Promise<void>;
	retireDoc<Value extends JsonObject, Seed extends JsonValue>(
		token: TaskDocFamilyToken<Value, Seed>,
		taskId: TaskId,
		key: string,
	): Promise<void>;
}
