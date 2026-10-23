import type { ConversationView } from "./view.ts";
import type { Context, JsonValue } from "@axi/chord";
import type {
	AssistantMessage,
	CacheRetention,
	ClientIdentity,
	Message,
	Models,
	ModelThinkingLevel,
	Static,
	Tool,
	ToolCall,
	ToolResultMessage,
	Transport,
	TSchema,
	Usage,
	UserMessage,
} from "@axi/ai";
import type { TelemetryContext } from "@axi/telemetry";
import type { ExecutionEnv, ShellOutputSkip, ShellOutputWindow } from "../env/index.ts";
import type {
	ConversationId,
	ConversationOwnership,
	ConversationRecord,
	Cursor,
	DocumentObserver,
	DocumentReader,
	EntryDraft,
	EntryId,
	EntryQuery,
	EntryRecord,
	JsonObject,
	Page,
	ReportInfo,
	Session,
	SetTimer,
	SubmissionId,
	SubmissionRecord,
	Task,
	TaskId,
	TaskOptions,
	TaskRecord,
	TaskState,
	Tx,
	WatchHandle,
} from "../types.ts";
import type { TaskGraphWatch } from "./task-graph.ts";
import type { UsageState } from "./usage.ts";

export type ModelRef = { readonly provider: string; readonly modelId: string };
export type UserInput = UserMessage["content"];
export type InputEntry = { readonly kind: string; readonly data?: JsonValue };
export type SubmissionDraft = { readonly requestId?: string } & (
	| {
			readonly type: "input";
			readonly content: UserInput;
			readonly whenBusy?: "steer" | "followUp" | "reject";
			readonly entry?: InputEntry;
	  }
	| { readonly type: "write"; readonly entry: EntryDraft; readonly content?: never; readonly whenBusy?: never }
);
export type InputSubmissionDraft = Extract<SubmissionDraft, { readonly type: "input" }>;
export type SettledSubmissionRecord = SubmissionRecord & { readonly status: "done" | "unanswered" };
export interface Submission {
	readonly id: SubmissionId;
	status(context: Context): Promise<SubmissionRecord>;
	wait(context: Context): Promise<SettledSubmissionRecord>;
	abort(context: Context): Promise<"aborted" | "already_placed" | "settled">;
}
export type SettledTask<R> = TaskRecord<JsonValue, JsonValue, R> & {
	readonly state: Extract<TaskState<JsonValue, R>, { readonly status: "terminal" }>;
};
export type AnyTask = {
	readonly definition: {
		readonly name: string;
		readonly version: number;
		readonly initial: unknown;
		readonly phases: Readonly<Record<string, unknown>>;
		readonly abort: unknown;
		readonly migrate?: unknown;
		readonly hooks?: object;
	};
};
export type ConversationAbortOptions = { readonly background?: boolean };
export type HooksOf<K> = K extends Task<infer _I, infer _S, infer _R, infer H> ? H : never;
export interface ConversationHandle {
	readonly id: ConversationId;
	submit(submission: InputSubmissionDraft, context: Context): Promise<Submission>;
	abort(context: Context, options?: ConversationAbortOptions): Promise<void>;
	waitForIdle(context: Context): Promise<void>;
}
export type ToolControl = {
	readonly addTools?: readonly string[];
	readonly terminate?: boolean;
	readonly handoff?: string;
};
export type ToolDiagnostic = {
	readonly severity: "info" | "warn" | "error";
	readonly message: string;
	readonly code?: string;
};
export type ToolExecutionResult<D extends JsonValue = JsonValue> = {
	readonly output?: ToolResultMessage["content"];
	readonly structuredOutput?: JsonValue;
	readonly isError?: boolean;
	readonly details?: D;
	readonly diagnostics?: readonly ToolDiagnostic[];
	readonly usage?: Usage;
	readonly control?: ToolControl;
};
export type NestedToolExecutionResult = {
	readonly taskId: TaskId;
	readonly structuredOutput?: JsonValue;
	readonly isError: boolean;
	readonly details?: JsonValue;
	readonly diagnostics: readonly ToolDiagnostic[];
	readonly usage?: Usage;
	readonly durationMs?: number;
};
export type ToolExecutionMode = "parallel" | "sequential";
export type QueueMode = "all" | "one-at-a-time";
export interface ToolExecutionApi<D extends JsonValue = JsonValue> extends DocumentObserver, DocumentReader {
	readonly taskId: TaskId;
	readonly conversationId: ConversationId;
	readonly callId: string;
	readonly registry: RegistrySnapshot;
	agent(context: Context): Promise<Agent>;
	readonly models: Models;
	readonly env: ExecutionEnv | undefined;
	now(): number;
	output(chunk: string | Uint8Array, skipped?: ShellOutputSkip): void;
	readonly outputWindow: ShellOutputWindow | undefined;
	retainedOutput(): { readonly text: string; readonly truncated: boolean };
	diagnostic(diagnostic: ToolDiagnostic): void;
	details(value: D, context: Context): Promise<void>;
	commit<T>(change: (tx: Tx) => T | Promise<T>, context: Context): Promise<T>;
	memo<T extends JsonValue>(name: string, context: Context): Promise<T | undefined>;
	memo<T extends JsonValue>(name: string, candidate: T, context: Context): Promise<T>;
	createTask<I, S extends { phase: string }, R, H extends object>(
		task: Task<I, S, R, H>,
		input: I,
		options: Omit<TaskOptions, "conversationId">,
		context: Context,
	): Promise<TaskId<R>>;
	getTask<R>(id: TaskId<R>, context: Context): Promise<TaskRecord<JsonValue, JsonValue, R> | undefined>;
	waitForTask<R>(id: TaskId<R>, context: Context): Promise<SettledTask<R>>;
	conversation(id: ConversationId, context: Context): Promise<ConversationHandle | undefined>;
	executeTool(
		name: string,
		args: JsonObject,
		context: Context,
		options?: { readonly key?: string; readonly progress?: boolean },
	): Promise<NestedToolExecutionResult>;
}
export type ToolRegistration<P extends TSchema = TSchema, D extends JsonValue = JsonValue> = Tool<P> & {
	readonly replay?: "safe" | "unsafe";
	readonly executionMode?: ToolExecutionMode;
	prepareArguments?(args: unknown): Static<P>;
	readonly structuredOutputSchema?: TSchema;
	readonly callers?: readonly ("model" | "tools")[];
	readonly deferred?: true;
	readonly outputLimits?: { readonly maxBytes?: number; readonly maxLines?: number; readonly retain?: "head" | "tail" };
	execute(args: Static<P>, api: ToolExecutionApi<D>, context: Context): Promise<ToolExecutionResult<D>>;
};
export type PromptInput<T extends ToolRegistration = ToolRegistration> = {
	readonly conversationId: ConversationId;
	readonly agent: Agent<T>;
	readonly env: ExecutionEnv | undefined;
	readonly shown: Readonly<Record<string, string>>;
	readonly read: DocumentReader;
};
export type PromptSection<T extends ToolRegistration = ToolRegistration> = {
	readonly key: string;
	render(input: PromptInput<T>, context: Context): string | undefined | Promise<string | undefined>;
	readonly tag?: boolean;
};
export type HookRegistration = { readonly task: string; readonly handlers: object };
export type Wrap<T extends ToolRegistration = ToolRegistration> =
	| { readonly tool: string; wrap(tool: T): T }
	| { readonly section: string; wrap(section: PromptSection<T>): PromptSection<T> };
export interface Extension<T extends ToolRegistration = ToolRegistration> {
	readonly name: string;
	readonly tools?: readonly T[];
	readonly sections?: readonly PromptSection<T>[];
	readonly hooks?: readonly HookRegistration[];
	readonly wraps?: readonly Wrap<T>[];
	readonly tasks?: readonly AnyTask[];
}
export interface RegistrySnapshot<T extends ToolRegistration = ToolRegistration> {
	installed(): readonly Extension<T>[];
	extension(name: string): Extension<T> | undefined;
	tools(): readonly { readonly extension: Extension<T>; readonly tool: T }[];
	sections(): readonly { readonly extension: Extension<T>; readonly section: PromptSection<T> }[];
	tasks(): readonly AnyTask[];
	task(name: string): AnyTask | undefined;
}
export interface RegistryReader<T extends ToolRegistration = ToolRegistration> {
	snapshot(): RegistrySnapshot<T>;
	subscribe(listener: () => void): () => void;
}
export interface Registry<T extends ToolRegistration = ToolRegistration> extends RegistryReader<T> {
	install(extension: Extension<T>): void;
	uninstall(extension: Extension): void;
}
export type AgentState = {
	model?: ModelRef;
	thinkingLevel?: ModelThinkingLevel;
	extensions?: string[] | { add?: string[]; remove?: string[] };
	tools?: string[] | { remove: string[] };
	modelTools?: string[] | { remove?: string[]; add?: string[] };
	instructions?: string;
	cwd?: string;
};
export type AgentChange = {
	readonly model?: ModelRef | null;
	readonly thinkingLevel?: ModelThinkingLevel | null;
	readonly extensions?:
		| readonly Extension[]
		| { readonly add?: readonly Extension[]; readonly remove?: readonly Extension[] }
		| null;
	readonly tools?: readonly ToolRegistration[] | { readonly remove: readonly ToolRegistration[] } | null;
	readonly modelTools?:
		| readonly ToolRegistration[]
		| { readonly remove?: readonly ToolRegistration[]; readonly add?: readonly ToolRegistration[] }
		| null;
	readonly instructions?: string | null;
	readonly cwd?: string | null;
};
export type Agent<T extends ToolRegistration = ToolRegistration> = {
	readonly model?: ModelRef;
	readonly thinkingLevel: ModelThinkingLevel;
	readonly extensions: readonly Extension<T>[];
	readonly tools: readonly T[];
	readonly callable: readonly T[];
	readonly deferred: readonly T[];
	readonly sections: readonly PromptSection<T>[];
	readonly instructions?: string;
	readonly cwd?: string;
};
export type ConversationStreamOptions = {
	transport?: Transport;
	timeoutMs?: number;
	maxRetries?: number;
	maxRetryDelayMs?: number;
	headers?: Record<string, string>;
	metadata?: JsonObject;
	cacheRetention?: CacheRetention;
	deferred?: boolean | { window?: "15m" | "1h" | "24h" };
};
export type ConversationRetryPolicy = {
	enabled: boolean;
	maxRetries: number;
	baseDelayMs: number;
	maxAgentDelayMs?: number;
};
export type CompactionPolicy = {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
	backgroundTokens: number;
};
export type CompactionSettings = Partial<CompactionPolicy> & {
	readonly modelOverrides?: Readonly<Record<string, Partial<CompactionPolicy>>>;
};
export type ProgressPolicy = { partialIntervalMs: number; outputIntervalMs: number };
export type AfterFailedRun = "keep" | "continue" | "withdraw";
export type HarnessSettings = {
	readonly extensions?: readonly Extension[];
	readonly stream?: ConversationStreamOptions;
	readonly retry?: Partial<ConversationRetryPolicy>;
	readonly compaction?: CompactionSettings;
	readonly progress?: Partial<ProgressPolicy>;
	readonly toolExecution?: ToolExecutionMode;
	readonly steeringMode?: QueueMode;
	readonly followUpMode?: QueueMode;
	readonly contextRetentionMs?: number;
	readonly documentRetentionMs?: number;
	readonly afterFailedRun?: AfterFailedRun;
	readonly restartLimit?: number;
};
export type CompactionReason = "manual" | "threshold" | "overflow";
export type CompactionResult = { entryId?: import("../types.ts").EntryId; submissionId?: SubmissionId };
export type Settings = {
	readonly extensions?: readonly Extension[];
	readonly stream: ConversationStreamOptions;
	readonly retry: ConversationRetryPolicy;
	readonly compaction: CompactionPolicy & Pick<CompactionSettings, "modelOverrides">;
	readonly progress: ProgressPolicy;
	readonly toolExecution: ToolExecutionMode;
	readonly steeringMode: QueueMode;
	readonly followUpMode: QueueMode;
	readonly contextRetentionMs: number;
	readonly documentRetentionMs: number;
	readonly afterFailedRun: AfterFailedRun;
	readonly restartLimit: number;
};
export type ContextView = {
	readonly head: EntryRecord | undefined;
	readonly entries: readonly EntryRecord[];
	readonly contributions: readonly (readonly Message[])[];
	readonly messages: readonly Message[];
};

export type Wake = { readonly active: boolean; readonly at?: number };
export type TaskInspection = {
	readonly record: TaskRecord<JsonValue, JsonValue, JsonValue>;
	readonly state:
		| { readonly kind: "running" }
		| { readonly kind: "ready"; readonly migrates: boolean }
		| { readonly kind: "waiting"; readonly on: readonly TaskId[] }
		| { readonly kind: "sleeping"; readonly until: number }
		| { readonly kind: "completing" }
		| {
				readonly kind: "blocked";
				readonly reason: "missing_task" | "task_too_old" | "migration_failed" | "restart_limit";
				readonly error?: unknown;
		  };
};
export type HarnessInspection = {
	readonly scheduling: "paused" | "running" | "closing";
	readonly tasks: readonly TaskInspection[];
	readonly submissions: readonly SubmissionRecord[];
};

export interface HookApi extends DocumentReader {
	readonly taskId: TaskId;
	readonly conversationId: ConversationId;
	readonly models: Models;
	memo<T extends JsonValue>(name: string, context: Context): Promise<T | undefined>;
	memo<T extends JsonValue>(name: string, candidate: T, context: Context): Promise<T>;
}
export type HookResult<T> = T | undefined | Promise<T | undefined>;
export interface GenerationHooks {
	beforeRequest(
		request: { readonly messages: readonly Message[] },
		api: HookApi,
		context: Context,
	): HookResult<{ readonly messages: readonly Message[] }>;
	afterResponse(message: AssistantMessage, api: HookApi, context: Context): void | Promise<void>;
	onYield(answer: AssistantMessage, api: HookApi, context: Context): HookResult<{ readonly continue: UserInput }>;
	afterTools(assistant: EntryId, results: readonly EntryId[], api: HookApi, context: Context): void | Promise<void>;
}
export type ToolHookCall = ToolCall & { readonly parent?: { readonly taskId: TaskId; readonly callId: string } };
export interface ToolHooks {
	beforeTool(
		call: ToolHookCall,
		api: HookApi,
		context: Context,
	): HookResult<{ readonly arguments?: JsonObject; readonly block?: string }>;
	afterTool(
		call: ToolHookCall,
		result: ToolExecutionResult,
		api: HookApi,
		context: Context,
	): HookResult<ToolExecutionResult>;
}
export interface CompactionHooks {
	beforeCompact(
		compaction: {
			readonly reason: CompactionReason;
			readonly entries: readonly EntryRecord[];
			readonly messages: readonly Message[];
			readonly firstKept: EntryId;
			readonly instructions?: string;
		},
		api: HookApi,
		context: Context,
	): HookResult<{ readonly decline: true } | { readonly summary: string }>;
}

export type ConversationInit = (tx: Tx, conversationId: ConversationId) => void | Promise<void>;
export type ConversationCreateOptions = {
	readonly ownership: ConversationOwnership;
	readonly agent?: AgentChange;
	readonly init?: ConversationInit;
};
export type EnvTarget = {
	readonly conversationId: ConversationId;
	readonly cwd?: string;
	readonly read: DocumentReader;
};
export type HarnessOptions<T extends ToolRegistration = ToolRegistration> = {
	/** Open without writing or recovering tasks. */
	readonly readOnly?: boolean;
	/** Root adapter for task and submission spans, events and metrics. */
	readonly telemetry?: TelemetryContext;
	readonly models: Models | (() => Models);
	readonly identity?: ClientIdentity;
	readonly registry: RegistryReader<T>;
	readonly settings?: HarnessSettings | (() => HarnessSettings | undefined);
	readonly env?: (target: EnvTarget, context: Context) => ExecutionEnv | undefined | Promise<ExecutionEnv | undefined>;
	readonly conversationCreated?: (tx: Tx, conversation: ConversationRecord) => void | Promise<void>;
	readonly now?: () => number;
	readonly setTimer?: SetTimer;
	readonly onWake?: (wake: Wake) => void;
	readonly onReport?: (error: unknown, info: ReportInfo) => void;
};
export type ConversationWatch = WatchHandle<ConversationView>;
export interface Conversation {
	readonly id: ConversationId;
	agent(context: Context): Promise<Agent>;
	configure(change: AgentChange, context: Context): Promise<void>;
	submit(submission: SubmissionDraft, context: Context): Promise<Submission>;
	reset(handoff: string | undefined, context: Context): Promise<void>;
	compact(instructions: string | undefined, context: Context): Promise<TaskId<CompactionResult>>;
	commit<T>(change: (tx: Tx) => T | Promise<T>, context: Context): Promise<T>;
	context(context: Context, options?: { readonly at?: EntryId }): Promise<ContextView>;
	entries(
		query: Omit<EntryQuery, "conversationId">,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<EntryRecord, Cursor>>;
	fork(at: EntryId, options: ConversationCreateOptions, context: Context): Promise<Conversation>;
	abort(context: Context, options?: ConversationAbortOptions): Promise<void>;
	waitForIdle(context: Context): Promise<void>;
	watch(context: Context): Promise<ConversationWatch>;
}
export interface Harness extends Session {
	resume(): void;
	wake(): Wake;
	root(
		context: Context,
		options?: { readonly agent?: AgentChange; readonly init?: ConversationInit },
	): Promise<Conversation>;
	conversation(id: ConversationId, context: Context): Promise<Conversation | undefined>;
	createConversation(options: ConversationCreateOptions, context: Context): Promise<Conversation>;
	getTask<R>(id: TaskId<R>, context: Context): Promise<TaskRecord<JsonValue, JsonValue, R> | undefined>;
	inspect(context: Context): Promise<HarnessInspection>;
	submission(id: SubmissionId, context: Context): Promise<Submission | undefined>;
	abortSubmission(
		id: SubmissionId,
		context: Context,
		conversationId?: ConversationId,
	): Promise<"aborted" | "already_placed" | "settled" | "not_found">;
	abortTask(id: TaskId, context: Context): Promise<"marked" | "terminal">;
	retryTask(id: TaskId, context: Context): Promise<void>;
	waitForTask<R>(id: TaskId<R>, context: Context): Promise<SettledTask<R>>;
	waitForIdle(context: Context): Promise<void>;
	usage(context: Context): Promise<UsageState>;
	watchTaskGraph(context: Context): Promise<TaskGraphWatch>;
}
