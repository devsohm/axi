import type { Context, JsonValue } from "@axi/chord";
import { withAbortSignal, withoutAbortSignal } from "@axi/chord/context";
import { AXI_ATTRIBUTION, mergeClientIdentity, withClientIdentity, type Models, type ClientIdentity } from "@axi/ai";
import {
	createTypedMetrics,
	NOOP_TELEMETRY_CONTEXT,
	NOOP_TELEMETRY_METRICS,
	type SpanAttributes,
	type TelemetryContext,
} from "@axi/telemetry";
import { ResetEntry } from "../entries.ts";
import type { ExecutionEnv } from "../env/index.ts";
import { contained, SessionImpl } from "../session/session.ts";
import type { Transaction } from "../session/transaction.ts";
import { hostTimers } from "../timers.ts";
import type {
	ConversationId,
	ConversationOwnership,
	ConversationRecord,
	Cursor,
	EntryId,
	EntryQuery,
	EntryRecord,
	Page,
	ReportInfo,
	Storage,
	SubmissionId,
	TaskId,
	TaskRecord,
	Tx,
} from "../types.ts";
import { ROOT_CONVERSATION_ID } from "../types.ts";
import { AgentDoc, configure, createAgent, resolveAgent, resolveSettings } from "./agent.ts";
import { createCompaction } from "./compaction.ts";
import { readContext } from "./context.ts";
import { InboxDoc, withdrawQueuedInputs } from "./inbox.ts";
import { LiveDoc, settleSchedulerOutcome } from "./live.ts";
import { ProviderDoc } from "./provider.ts";
import { BUILTIN_TASKS } from "./registry.ts";
import { type InvocationBinding, TaskScheduler } from "./scheduler.ts";
import { Submissions } from "./submissions.ts";
import { TaskGraphView, type TaskGraphWatch } from "./task-graph.ts";
import { DURABLE_TELEMETRY_SCHEMA } from "./telemetry.ts";
import type {
	Agent,
	AgentChange,
	CompactionResult,
	ContextView,
	Conversation,
	ConversationAbortOptions,
	ConversationCreateOptions,
	ConversationHandle,
	ConversationInit,
	ConversationWatch,
	HarnessInspection,
	HarnessOptions,
	HarnessSettings,
	Harness as HarnessType,
	RegistrySnapshot,
	SettledTask,
	Submission,
	SubmissionDraft,
	ToolRegistration,
	Wake,
} from "./types.ts";
import { addUsageState, UsageDoc, type UsageState } from "./usage.ts";
import { scanAll } from "./util.ts";
import { ConversationViews } from "./view.ts";

type CreateTarget =
	| { kind: "root" }
	| { kind: "independent"; ownership: ConversationOwnership }
	| { kind: "fork"; parentId: ConversationId; at: EntryId; ownership: ConversationOwnership };
type CreateOptions = { readonly agent?: AgentChange; readonly init?: ConversationInit };
type Host<T extends ToolRegistration> = {
	readonly harness: HarnessImpl<T>;
	readonly storage: Storage;
	readonly tasks: TaskScheduler;
	readonly submissions: Submissions;
	readonly views: ConversationViews;
	readonly now: () => number;
	create(target: CreateTarget, options: CreateOptions, context: Context): Promise<Conversation>;
};
export const SCHEDULER_INDEX_SIZES = Symbol.for("axi-durable.schedulerIndexSizes");

class ConversationImpl<T extends ToolRegistration> implements Conversation {
	readonly id: ConversationId;
	readonly #host: Host<T>;
	constructor(id: ConversationId, host: Host<T>) {
		this.id = id;
		this.#host = host;
	}
	agent(context: Context): Promise<Agent> {
		return this.#host.harness.resolveAgent(this.id, undefined, context);
	}
	configure(change: AgentChange, context: Context): Promise<void> {
		return this.#host.harness.commitWith((tx) => configure(tx, this.id, change), context);
	}
	submit(draft: SubmissionDraft, context: Context): Promise<Submission> {
		return this.#host.submissions.submit(this.id, draft, context);
	}
	async compact(instructions: string | undefined, context: Context): Promise<TaskId<CompactionResult>> {
		this.#host.tasks.resume();
		return this.#host.harness.commitWith(
			(tx) =>
				createCompaction(tx, this.id, { reason: "manual", ...(instructions === undefined ? {} : { instructions }) }),
			context,
		);
	}
	async reset(handoff: string | undefined, context: Context): Promise<void> {
		await this.#host.submissions.submit(
			this.id,
			{
				type: "write",
				entry: {
					kind: ResetEntry.kind,
					head: "self",
					...(handoff === undefined
						? {}
						: { model: [{ role: "user", content: handoff, timestamp: this.#host.now() }] }),
				},
			},
			context,
		);
	}
	commit<V>(change: (tx: Tx) => V | Promise<V>, context: Context): Promise<V> {
		return this.#host.harness.commitWith(change, context, { conversationId: this.id });
	}
	context(context: Context, options?: { readonly at?: EntryId }): Promise<ContextView> {
		return readContext(this.#host.harness, this.#host.storage, this.id, context, options?.at);
	}
	entries(
		query: Omit<EntryQuery, "conversationId">,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<EntryRecord, Cursor>> {
		const bounded: EntryQuery = {
			conversationId: this.id,
			...(query.minEntryId === undefined ? {} : { minEntryId: query.minEntryId }),
			...(query.maxEntryId === undefined ? {} : { maxEntryId: query.maxEntryId }),
			...(query.order === undefined ? {} : { order: query.order }),
		};
		return this.#host.harness.readOnLine(() => this.#host.storage.scanEntries(bounded, limit, cursor, context));
	}
	fork(at: EntryId, options: ConversationCreateOptions, context: Context): Promise<Conversation> {
		return this.#host.create({ kind: "fork", parentId: this.id, at, ownership: options.ownership }, options, context);
	}
	async abort(context: Context, options?: ConversationAbortOptions): Promise<void> {
		this.#host.tasks.resume();
		return this.#host.tasks.abortConversation(this.id, options?.background === true, context);
	}
	async waitForIdle(context: Context): Promise<void> {
		this.#host.tasks.resume();
		return this.#host.tasks.waitForIdle(this.id, context);
	}
	watch(context: Context): Promise<ConversationWatch> {
		return this.#host.views.watch(this.id, context);
	}
}

export const DEFAULT_HARNESS_IDENTITY: ClientIdentity = { attribution: AXI_ATTRIBUTION };
function modelsGetter(models: HarnessOptions["models"], identity?: ClientIdentity): () => Models {
	const resolved = mergeClientIdentity(DEFAULT_HARNESS_IDENTITY, identity) ?? DEFAULT_HARNESS_IDENTITY;
	if (typeof models === "function") return () => withClientIdentity(models(), resolved);
	const wrapped = withClientIdentity(models, resolved);
	return () => wrapped;
}
function settingsGetter(settings: HarnessOptions["settings"]): () => HarnessSettings | undefined {
	return typeof settings === "function" ? settings : () => settings;
}
class HarnessImpl<T extends ToolRegistration> extends SessionImpl implements HarnessType {
	readonly #options: HarnessOptions<T>;
	readonly #settings: () => HarnessSettings | undefined;
	readonly #report: (error: unknown, info: ReportInfo, context?: Context) => void;
	readonly #host: Host<T>;
	readonly #tasks: TaskScheduler;
	readonly #submissions: Submissions;
	readonly #graph: TaskGraphView;
	constructor(raw: Storage, options: HarnessOptions<T>, context: Context) {
		const report = safeReport(options.onReport, options.telemetry ?? NOOP_TELEMETRY_CONTEXT),
			now = safeNow(options.now, report),
			hostSettings = settingsGetter(options.settings);
		super(raw, now, () => hostSettings()?.documentRetentionMs, options.setTimer, options.readOnly);
		const storage = this.storage,
			settings = () => resolveSettings(hostSettings());
		this.#options = options;
		this.#settings = hostSettings;
		this.#report = report;
		this.#tasks = new TaskScheduler({
			readOnly: options.readOnly,
			telemetry: options.telemetry,
			session: this,
			storage,
			registry: options.registry,
			models: modelsGetter(options.models, options.identity),
			agent: (id, snapshot, context) => this.resolveAgent(id, snapshot as RegistrySnapshot<T>, context),
			settings,
			env: (id, context) => this.buildEnv(id, context),
			now,
			onWake: options.onWake,
			timers: hostTimers(options.setTimer, (error) => report(error, { type: "host_error", callback: "setTimer" })),
			writeAtClose: (writes) => this.writeAtClose(writes),
			report,
			settleOutcome: settleSchedulerOutcome,
			withdrawInputs: withdrawQueuedInputs,
			conversation: async (id, binding, context) =>
				(await this.readOnLine(() => storage.conversation(id, context))) === undefined
					? undefined
					: boundConversation(id, binding, this.#submissions, this.#tasks),
			context: withoutAbortSignal(context),
		});
		this.#submissions = new Submissions(this, storage, now, settings, () => this.#tasks.resume(), options.telemetry);
		this.#graph = new TaskGraphView(this, storage, {
			blocked: (task) => this.#tasks.blockedReason(task),
			subscribeBlocked: (listener) => this.#tasks.subscribeBlocked(listener),
		});
		this.#host = {
			harness: this,
			storage,
			tasks: this.#tasks,
			submissions: this.#submissions,
			views: new ConversationViews(this, storage),
			now,
			create: (target, options, context) => this.#create(target, options, context),
		};
	}
	async resolveAgent(
		id: ConversationId,
		snapshot: RegistrySnapshot<T> | undefined,
		context: Context,
	): Promise<Agent<T>> {
		const registry = snapshot ?? this.#options.registry.snapshot(),
			state = await this.snapshot(AgentDoc, id, context);
		return resolveAgent(state, registry, resolveSettings(this.#settings()), (error, extension) =>
			this.#report(error, { type: "extension_error", conversationId: id, extension }, context),
		);
	}
	async buildEnv(id: ConversationId, context: Context): Promise<ExecutionEnv | undefined> {
		const build = this.#options.env;
		if (build === undefined) return;
		const cwd = (await this.snapshot(AgentDoc, id, context))?.cwd;
		return build({ conversationId: id, ...(cwd === undefined ? {} : { cwd }), read: this }, context);
	}
	openTasks(context: Context): Promise<void> {
		return this.#tasks.open(context);
	}
	resume(): void {
		this.assertUsable();
		this.#tasks.resume();
	}
	wake(): Wake {
		this.assertUsable();
		return this.#tasks.wake();
	}
	getTask<R>(id: TaskId<R>, context: Context): Promise<TaskRecord<JsonValue, JsonValue, R> | undefined> {
		return this.readOnLine(() => this.storage.task(id, context)) as Promise<
			TaskRecord<JsonValue, JsonValue, R> | undefined
		>;
	}
	get [SCHEDULER_INDEX_SIZES]() {
		return this.#tasks.indexSizes;
	}
	inspect(context: Context): Promise<HarnessInspection> {
		return this.readOnLine(async () => {
			const state = await this.#tasks.inspect(this.#options.registry.snapshot()),
				scan = (status: "queued" | "placed") =>
					scanAll((cursor) => this.storage.scanSubmissions({ status }, 256, cursor, context));
			return {
				...state,
				submissions: [...(await scan("queued")), ...(await scan("placed"))].sort((left, right) => left.id - right.id),
			};
		});
	}
	submission(id: SubmissionId, context: Context): Promise<Submission | undefined> {
		return this.#submissions.get(id, context);
	}
	abortSubmission(
		id: SubmissionId,
		context: Context,
		conversationId?: ConversationId,
	): Promise<"aborted" | "already_placed" | "settled" | "not_found"> {
		return this.#submissions.abort(id, context, conversationId);
	}
	abortTask(id: TaskId, context: Context): Promise<"marked" | "terminal"> {
		return this.#tasks.abort(id, context);
	}
	retryTask(id: TaskId, context: Context): Promise<void> {
		this.assertUsable();
		return this.#tasks.retry(id, context);
	}
	async waitForTask<R>(id: TaskId<R>, context: Context): Promise<SettledTask<R>> {
		this.#tasks.resume();
		return this.#tasks.waitForTask(id, context) as Promise<SettledTask<R>>;
	}
	async waitForIdle(context: Context): Promise<void> {
		this.#tasks.resume();
		return this.#tasks.waitForIdle(undefined, context);
	}
	async usage(context: Context): Promise<UsageState> {
		const conversations = await this.readOnLine(() =>
				scanAll((cursor) => this.storage.scanConversations({}, 256, cursor, context)),
			),
			total = UsageDoc.definition.initial();
		for (const { id } of conversations) {
			const state = await this.snapshot(UsageDoc, id, context);
			if (state !== undefined) addUsageState(total, state);
		}
		return total;
	}
	watchTaskGraph(context: Context): Promise<TaskGraphWatch> {
		return this.#graph.watch(context);
	}
	root(context: Context, options?: CreateOptions): Promise<Conversation> {
		return this.#create({ kind: "root" }, options ?? {}, context);
	}
	async conversation(id: ConversationId, context: Context): Promise<Conversation | undefined> {
		this.assertUsable();
		return (await this.readOnLine(() => this.storage.conversation(id, context))) === undefined
			? undefined
			: new ConversationImpl(id, this.#host);
	}
	createConversation(options: ConversationCreateOptions, context: Context): Promise<Conversation> {
		return this.#create({ kind: "independent", ownership: options.ownership }, options, context);
	}
	override report(error: unknown, info: ReportInfo = { type: "listener_error" }, context?: Context): void {
		this.#report(error, info, context);
	}
	protected override beforeClose(): Promise<void> {
		return this.#tasks.join();
	}
	async #create(target: CreateTarget, options: CreateOptions, context: Context): Promise<Conversation> {
		this.assertUsable();
		const id = await this.commitWith(async (tx) => {
			if (target.kind === "root" && (await tx.conversation(ROOT_CONVERSATION_ID)) !== undefined)
				return ROOT_CONVERSATION_ID;
			const record =
				target.kind === "root"
					? await tx.createRootConversation()
					: target.kind === "fork"
						? await tx.forkConversation(target.parentId, target.at, { ownership: target.ownership })
						: await tx.createConversation({ ownership: target.ownership });
			if (options.agent !== undefined) await configure(tx, record.id, options.agent);
			await options.init?.(tx, record.id);
			return record.id;
		}, context);
		return new ConversationImpl(id, this.#host);
	}
	protected override async conversationCreated(tx: Transaction, record: ConversationRecord): Promise<void> {
		await tx.doc(LiveDoc, record.id);
		await tx.doc(InboxDoc, record.id);
		await tx.doc(UsageDoc, record.id);
		await tx.doc(ProviderDoc, record.id);
		await createAgent(tx, record);
		await this.#options.conversationCreated?.(tx, record);
	}
}
function safeReport(
	onReport: HarnessOptions["onReport"],
	telemetry: TelemetryContext,
): (error: unknown, info: ReportInfo, context?: Context) => void {
	const reports = createTypedMetrics(telemetry.metrics ?? NOOP_TELEMETRY_METRICS, [DURABLE_TELEMETRY_SCHEMA]).counter(
		"axi.durable.reports",
	);
	return (error, info, context) => {
		contained(
			() => onReport?.(error, info),
			() => {},
		);
		const fields: SpanAttributes = { type: info.type };
		switch (info.type) {
			case "task_faulted":
			case "task_outdated":
				fields.reason = info.reason;
				fields.extension = info.extension;
				fields["task.id"] = info.task.id;
				break;
			case "task_parked":
			case "migration_failed":
			case "task_error":
			case "extension_error":
				fields.extension = info.extension;
				fields["task.id"] = info.task?.id;
				break;
			case "host_error":
				fields["task.id"] = info.task?.id;
				break;
		}
		reports.add(1, { type: info.type });
		context?.telemetry.addEvent("axi.durable.report", fields);
	};
}
export function safeNow(
	now: (() => number) | undefined,
	report: (error: unknown, info: ReportInfo) => void,
): () => number {
	if (now === undefined) return Date.now;
	let reported = false;
	return () => {
		try {
			return now();
		} catch (error) {
			if (!reported) {
				reported = true;
				report(error, { type: "host_error", callback: "now" });
			}
			return Date.now();
		}
	};
}
function boundConversation(
	id: ConversationId,
	binding: InvocationBinding,
	submissions: Submissions,
	tasks: TaskScheduler,
): ConversationHandle {
	const bind = (context: Context) => withAbortSignal(binding.signal, context);
	const bound =
		<V>(operation: (context: Context) => Promise<V>) =>
		async (context: Context): Promise<V> => {
			binding.check();
			return operation(bind(context));
		};
	return {
		id,
		submit: async (draft, context) => {
			binding.check();
			const submission = await submissions.submit(id, draft, bind(context));
			return {
				id: submission.id,
				status: bound((context) => submission.status(context)),
				wait: bound((context) => submission.wait(context)),
				abort: bound((context) => submission.abort(context)),
			};
		},
		abort: async (context, options) => {
			binding.check();
			return tasks.abortConversation(id, options?.background === true, bind(context));
		},
		waitForIdle: bound((context) => tasks.waitForIdle(id, context)),
	};
}
export type Harness = HarnessType;
export const Harness = {
	async open<T extends ToolRegistration>(
		storage: Storage,
		options: HarnessOptions<T>,
		context: Context,
	): Promise<Harness> {
		context.abortSignal?.throwIfAborted();
		const snapshot = options.registry.snapshot(),
			missing = BUILTIN_TASKS.filter((task) => snapshot.task(task.definition.name) === undefined);
		if (missing.length)
			throw new Error(
				`Registry lacks built-in tasks ${missing.map((task) => task.definition.name).join(", ")}; create it with createRegistry()`,
			);
		const harness = new HarnessImpl(storage, options, context);
		try {
			await harness.openTasks(context);
		} catch (error) {
			await harness.close(withoutAbortSignal(context)).catch(() => {});
			throw error;
		}
		return harness;
	},
};
