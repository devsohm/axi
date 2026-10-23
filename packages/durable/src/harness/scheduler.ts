import { type Context, copyJson, type JsonValue } from "@axi/chord";
import { awaitWithContext, withAbortSignal, withoutAbortSignal, withTelemetry } from "@axi/chord/context";
import type { Models } from "@axi/ai";
import {
	createTypedMetrics,
	createTypedSpanStarter,
	NOOP_TELEMETRY_CONTEXT,
	NOOP_TELEMETRY_METRICS,
	type TelemetryCarrier,
} from "@axi/telemetry";
import type { ExecutionEnv } from "../env/index.ts";
import { errorMessage, ReadOnlySession } from "../errors.ts";
import type { SessionImpl } from "../session/session.ts";
import type { Transaction } from "../session/transaction.ts";
import type { Timers } from "../timers.ts";
import type {
	CommitPublication,
	ConversationId,
	DocumentWatch,
	Entry,
	EntryId,
	HookRunner,
	JsonObject,
	NextTaskState,
	ReportInfo,
	ReportTask,
	RunningTask,
	Storage,
	StorageWrite,
	TaskDefinition,
	TaskId,
	TaskOutcome,
	TaskRecord,
	TaskRuntime,
	TaskState,
} from "../types.ts";
import { agentHooks, DEFAULT_RESTART_LIMIT } from "./agent.ts";
import { type ContextRange, readContextFrom } from "./context.ts";
import { jsonEqual as equal } from "./json.ts";
import {
	conversationNode,
	OwnershipTree,
	ownershipOverlay,
	type OwnershipNode,
	type StoredTask,
	taskParent,
} from "./ownership.ts";
import type {
	Agent,
	AnyTask,
	ConversationHandle,
	HarnessInspection,
	HarnessOptions,
	RegistryReader,
	RegistrySnapshot,
	Settings,
	SettledTask,
	TaskInspection,
	Wake,
} from "./types.ts";
import { closedError, optionalExtension, scanAll, Waiters } from "./util.ts";
import { DURABLE_TELEMETRY_SCHEMA } from "./telemetry.ts";

type Checkpoint = { readonly phase: string; readonly attempt?: number };
type Runnable = Extract<
	StoredTask,
	{ readonly state: { readonly status: "pending" | "running" | "waiting" | "sleeping" } }
>;
type Runtime = TaskRuntime<JsonValue, Checkpoint, JsonValue, Record<string, unknown>>;
type Running = RunningTask<JsonValue, Checkpoint, JsonValue>;
type Definition = TaskDefinition<JsonValue, Checkpoint, JsonValue, Record<string, unknown>>;
export type BlockedReason = "missing_task" | "task_too_old" | "migration_failed" | "restart_limit";
export type BlockedSubject = Pick<
	StoredTask,
	"id" | "kind" | "version" | "abortRequested" | "abortReason" | "restarts"
> & {
	readonly status: TaskState<JsonValue, JsonValue>["status"];
};
export function blockedSubject(task: StoredTask): BlockedSubject {
	return {
		id: task.id,
		kind: task.kind,
		version: task.version,
		abortRequested: task.abortRequested,
		...(task.abortReason === undefined ? {} : { abortReason: task.abortReason }),
		...(task.restarts === undefined ? {} : { restarts: task.restarts }),
		status: task.state.status,
	};
}
export type SchedulerOutcome = Extract<TaskOutcome<JsonValue>, { readonly status: "faulted" | "orphaned" }>;
export type InvocationBinding = { readonly signal: AbortSignal; check(): void };
export type TaskSchedulerOptions = {
	readonly readOnly?: boolean;
	readonly telemetry?: HarnessOptions["telemetry"];
	readonly session: SessionImpl;
	readonly storage: Storage;
	readonly registry: RegistryReader;
	readonly models: () => Models;
	readonly agent: (id: ConversationId, snapshot: RegistrySnapshot, context: Context) => Promise<Agent>;
	readonly settings: () => Settings;
	readonly env: (id: ConversationId, context: Context) => Promise<ExecutionEnv | undefined>;
	readonly now: () => number;
	readonly onWake: ((wake: Wake) => void) | undefined;
	readonly timers: Timers;
	readonly writeAtClose: (writes: () => readonly StorageWrite[]) => Promise<void>;
	readonly report: (error: unknown, info: ReportInfo, context?: Context) => void;
	readonly settleOutcome: (tx: Transaction, task: StoredTask, outcome: SchedulerOutcome) => Promise<void>;
	readonly withdrawInputs: (tx: Transaction, id: ConversationId) => Promise<void>;
	readonly conversation: (
		id: ConversationId,
		binding: InvocationBinding,
		context: Context,
	) => Promise<ConversationHandle | undefined>;
	readonly context: Context;
};
type Invocation = {
	readonly taskId: TaskId;
	readonly kind: string;
	readonly conversationId: ConversationId;
	readonly extension: string | undefined;
	readonly mode: "run" | "abort";
	readonly controller: AbortController;
	context: Context;
	links?: readonly TelemetryCarrier[];
	record?: TaskRecord<JsonValue, Checkpoint, JsonValue>;
	fault?: Extract<TaskOutcome<JsonValue>, { readonly status: "faulted" }>;
	readonly watches: Set<DocumentWatch<JsonObject>>;
	readonly timers: Set<() => void>;
	readonly done: Promise<void>;
	readonly finish: () => void;
	ended: boolean;
};
type Reservation = { readonly invocation: Invocation; readonly task: AnyTask; readonly snapshot: RegistrySnapshot };
type Fit =
	| { readonly task: AnyTask; readonly migrates: boolean }
	| { readonly reason: BlockedReason; readonly error?: unknown };
type Phase = {
	snapshot: RegistrySnapshot;
	task: AnyTask;
	agent?: Promise<Agent>;
	reported?: { readonly task: AnyTask | undefined };
};
type Previous = { readonly checkpoint: Checkpoint; readonly failure?: { readonly error: unknown } };
const liveStatuses = ["pending", "running", "waiting", "sleeping", "completing"] as const;
const pageSize = 256;
const identity = (task: { taskId: TaskId; kind: string; conversationId: ConversationId }): ReportTask => ({
	id: task.taskId,
	kind: task.kind,
	conversationId: task.conversationId,
});
const recordIdentity = (record: StoredTask) => ({
	taskId: record.id,
	kind: record.kind,
	conversationId: record.conversationId,
});
const definition = (task: AnyTask): Definition => task.definition as unknown as Definition;
const ended = (run: Invocation): Error => new Error(`Task ${run.taskId} invocation has ended`);
function failed(record: StoredTask): boolean {
	return (
		(record.state.status === "terminal" || record.state.status === "completing") &&
		record.state.outcome.status !== "completed"
	);
}
function intent(record: StoredTask): boolean {
	return record.state.status !== "terminal" && (record.abortRequested || failed(record));
}
function progress(record: StoredTask): StoredTask {
	const { restarts: _, ...rest } = record;
	return rest as StoredTask;
}
function abortMark(record: StoredTask, reason?: "restart"): StoredTask {
	const { abortReason: _, restarts: __, ...rest } = record;
	return { ...rest, abortRequested: true, ...(reason === undefined ? {} : { abortReason: reason }) } as StoredTask;
}
function stateOf(record: StoredTask, state: TaskState<JsonValue, JsonValue>): StoredTask {
	if (state.status !== "terminal" && state.status !== "completing") return { ...record, state } as StoredTask;
	const { memos: _, restarts: __, ...rest } = record;
	return { ...rest, state };
}
function installer(snapshot: RegistrySnapshot, task: AnyTask | undefined): string | undefined {
	return task === undefined ? undefined : snapshot.installed().findLast((ext) => ext.tasks?.includes(task))?.name;
}
function memo(record: StoredTask | undefined, key: string): JsonValue | undefined {
	return record?.memos !== undefined && Object.hasOwn(record.memos, key) ? record.memos[key] : undefined;
}

export class TaskScheduler {
	readonly #telemetry: NonNullable<HarnessOptions["telemetry"]>;
	readonly #activeMetric;
	readonly #durationMetric;
	readonly #resumed = new Set<TaskId>();
	readonly #options: TaskSchedulerOptions;
	readonly #tree: OwnershipTree;
	readonly #runs = new Map<TaskId, Invocation>();
	readonly #ready = new Set<TaskId>();
	readonly #sleeping = new Set<TaskId>();
	readonly #parked = new Set<TaskId>();
	readonly #abandoned = new Set<TaskId>();
	readonly #cancelling = new Set<TaskId>();
	readonly #holders = new Set<TaskId>();
	readonly #dependents = new Map<TaskId, Set<TaskId>>();
	readonly #failFast = new Set<TaskId>();
	readonly #migrationFailures = new Map<TaskId, { readonly task: AnyTask; readonly error: unknown }>();
	readonly #taskWaiters = new Waiters<TaskId, SettledTask<JsonValue>>();
	readonly #idleWaiters = new Waiters<ConversationId | undefined, void>();
	readonly #blockedListeners = new Set<() => void>();
	readonly #contexts = new Map<ConversationId, { range: ContextRange; idleSince: number | undefined }>();
	#unsubscribe = () => {};
	#enabled = false;
	#closing = false;
	#dirty = false;
	#draining = false;
	#cascade = false;
	#reconcileQueued = false;
	#reconcileCount = 0;
	#pruneQueued = false;
	#wakeQueued = false;
	#lastWake: Wake | undefined;
	#timer: { at: number; cancel: () => void } | undefined;
	#expiry: { at: number; cancel: () => void } | undefined;
	#registryReported = false;
	constructor(options: TaskSchedulerOptions) {
		this.#telemetry = options.telemetry ?? NOOP_TELEMETRY_CONTEXT;
		const metrics = createTypedMetrics(this.#telemetry.metrics ?? NOOP_TELEMETRY_METRICS, [DURABLE_TELEMETRY_SCHEMA]);
		this.#activeMetric = metrics.upDownCounter("axi.durable.tasks.active");
		this.#durationMetric = metrics.histogram("axi.durable.phase.duration");
		this.#options = options;
		this.#tree = new OwnershipTree(options.storage, options.context);
	}
	async open(context: Context): Promise<void> {
		const { session, registry } = this.#options;
		session.observeCommits((publication) => this.#observe(publication));
		session.subscribeClose(() => this.#seal());
		this.#unsubscribe = registry.subscribe(() => {
			this.#notifyBlocked();
			this.#kick();
		});
		const limit = this.#restartLimit();
		const parked: StoredTask[] = [];
		await session.commitWith(async (tx) => {
			const groups = [];
			for (const status of liveStatuses)
				groups.push(await scanAll((cursor) => tx.scanTasks({ status }, pageSize, cursor)));
			for (const records of groups)
				for (const task of records) {
					this.#track(task);
					if (this.#options.readOnly) continue;
					this.#resumed.add(task.id);
					if (task.abandonOnRestart) this.#abandoned.add(task.id);
					if (task.state.status === "running") {
						const restarts = (task.restarts ?? 0) + 1;
						tx.setTask({
							...stateOf(task, { status: "pending", checkpoint: task.state.checkpoint }),
							restarts,
						} as StoredTask);
						if (restarts >= limit && !task.abortRequested) parked.push(task);
					}
				}
		}, context);
		if (this.#options.readOnly) return;
		for (const task of parked)
			this.#options.report(
				new Error(
					`Task ${task.id} (${task.kind}) was cut off ${(task.restarts ?? 0) + 1} times without progress; it is parked until retryTask()`,
				),
				{
					type: "task_parked",
					...this.#about(recordIdentity(task)),
				},
			);
		this.#cascade = true;
		this.#reconcileSoon();
		this.#scheduleWake();
	}
	resume(): void {
		if (this.#options.readOnly) throw new ReadOnlySession("running tasks");
		this.#enabled = true;
		this.#due();
		this.#kick();
	}
	async retry(id: TaskId, context: Context): Promise<void> {
		await this.#options.session.commitWith(async (tx) => {
			const task = await tx.task(id);
			if (task === undefined) throw new Error(`Task ${id} does not exist`);
			if (task.state.status !== "terminal" && task.state.status !== "completing" && this.#isParked(task))
				tx.setTask(progress(task));
		}, context);
		this.resume();
	}
	#fit(subject: Pick<StoredTask, "id" | "version">, task: AnyTask | undefined): Fit {
		if (task === undefined) return { reason: "missing_task" };
		if (task.definition.version < subject.version) return { reason: "task_too_old" };
		if (task.definition.version === subject.version) return { task, migrates: false };
		const failure = this.#migrationFailures.get(subject.id);
		return failure?.task === task ? { reason: "migration_failed", error: failure.error } : { task, migrates: true };
	}
	blockedReason(subject: BlockedSubject): BlockedReason | undefined {
		if (["running", "terminal", "completing"].includes(subject.status)) return;
		if (subject.abortRequested && subject.abortReason === undefined) return;
		if (this.#isParked(subject)) return "restart_limit";
		let snapshot: RegistrySnapshot;
		try {
			snapshot = this.#options.registry.snapshot();
		} catch (error) {
			if (!this.#registryReported) this.#hostError(error, "registry");
			this.#registryReported = true;
			return;
		}
		const fit = this.#fit(subject, snapshot.task(subject.kind));
		if ("reason" in fit) return fit.reason;
		return fit.migrates && fit.task.definition.migrate === undefined ? "migration_failed" : undefined;
	}
	subscribeBlocked(listener: () => void): () => void {
		this.#blockedListeners.add(listener);
		return () => this.#blockedListeners.delete(listener);
	}
	#notifyBlocked(): void {
		for (const listener of [...this.#blockedListeners])
			try {
				listener();
			} catch (error) {
				this.#options.report(error, { type: "listener_error" });
			}
	}
	#hostError(error: unknown, callback: "registry" | "settings" | "onWake"): void {
		this.#options.report(error, { type: "host_error", callback });
	}
	#restartLimit(): number {
		try {
			return this.#options.settings().restartLimit;
		} catch (error) {
			this.#hostError(error, "settings");
			return DEFAULT_RESTART_LIMIT;
		}
	}
	#isParked(record: Pick<StoredTask, "abortRequested" | "restarts">): boolean {
		return !record.abortRequested && record.restarts !== undefined && record.restarts >= this.#restartLimit();
	}
	#about(task: { taskId: TaskId; kind: string; conversationId: ConversationId; extension?: string | undefined }) {
		let owner = task.extension;
		if (!("extension" in task))
			try {
				const snapshot = this.#options.registry.snapshot();
				owner = installer(snapshot, snapshot.task(task.kind));
			} catch {}
		return { task: identity(task), ...optionalExtension(owner) };
	}
	#cancelled(start: OwnershipNode): StoredTask | undefined {
		if (!this.#cancelling.size) return;
		for (const step of this.#tree.ancestors(start)) {
			if (step.kind === "unknown") return;
			if (step.kind !== "task") continue;
			const record = this.#tree.live.get(step.id);
			if (record !== undefined && intent(record)) return record;
			if (step.node.background) return;
		}
	}
	#waiting(task: StoredTask, first = false): readonly TaskId[] {
		if (task.abortRequested) return this.#tree.owned(task.id, undefined, first);
		if (task.state.status !== "waiting") return [];
		if (!first) return task.state.on.filter((id) => this.#tree.live.has(id));
		const member = task.state.on.find((id) => this.#tree.live.has(id));
		return member === undefined ? [] : [member];
	}
	#notDue(
		task: StoredTask,
	): task is StoredTask & { readonly state: { readonly status: "sleeping"; readonly until: number } } {
		return task.state.status === "sleeping" && !task.abortRequested && task.state.until > this.#options.now();
	}
	#due(): void {
		for (const id of this.#sleeping) {
			const task = this.#tree.live.get(id);
			if (task !== undefined && !this.#notDue(task)) this.#ready.add(id);
		}
	}
	wake(): Wake {
		if (this.#options.readOnly) return { active: false };
		const now = this.#options.now();
		let active = this.#runs.size > 0 || this.#reconcileCount > 0 || this.#hasReconcileWork();
		let at: number | undefined, snapshot: RegistrySnapshot | undefined;
		let snapshotFailed = false;
		for (const task of this.#tree.live.values()) {
			if (task.state.status === "completing") continue;
			if (
				task.state.status === "waiting" &&
				!task.abortRequested &&
				task.state.on.some((id) => this.#tree.live.has(id))
			)
				continue;
			if (task.state.status === "sleeping" && !task.abortRequested && task.state.until > now) {
				at = at === undefined ? task.state.until : Math.min(at, task.state.until);
				continue;
			}
			if (active || this.#isParked(task) || (task.abortRequested && this.#waiting(task, true).length)) continue;
			if (!task.abortRequested || task.abortReason !== undefined) {
				if (snapshot === undefined && !snapshotFailed)
					try {
						snapshot = this.#options.registry.snapshot();
					} catch (error) {
						snapshotFailed = true;
						this.#hostError(error, "registry");
					}
				if (snapshot !== undefined && "reason" in this.#fit(task, snapshot.task(task.kind))) continue;
			}
			active = true;
		}
		return { active, ...(at === undefined ? {} : { at }) };
	}
	#scheduleWake(): void {
		if (this.#options.readOnly || this.#wakeQueued || this.#closing) return;
		this.#wakeQueued = true;
		queueMicrotask(() => {
			this.#wakeQueued = false;
			if (this.#closing) return;
			const wake = this.wake();
			if (this.#options.onWake === undefined) {
				const at = this.#enabled ? wake.at : undefined;
				if (this.#timer?.at === at) return;
				this.#timer?.cancel();
				this.#timer = undefined;
				if (at !== undefined)
					this.#timer = {
						at,
						cancel: this.#options.timers.foreground(() => {
							this.#timer = undefined;
							this.#due();
							this.#kick();
						}, at - this.#options.now()),
					};
				return;
			}
			if (equal(wake, this.#lastWake)) return;
			try {
				this.#options.onWake(wake);
				this.#lastWake = wake;
			} catch (error) {
				this.#hostError(error, "onWake");
			}
		});
	}
	#seal(): void {
		for (const task of this.#tree.live.values()) this.#activeMetric.add(-1, { task: task.kind });
		this.#resumed.clear();
		this.#closing = true;
		try {
			this.#unsubscribe();
		} catch (error) {
			this.#hostError(error, "registry");
		}
		const error = closedError(this.#options.session);
		this.#taskWaiters.rejectAll(error);
		this.#idleWaiters.rejectAll(error);
		this.#contexts.clear();
		this.#expiry?.cancel();
		this.#expiry = undefined;
		this.#timer?.cancel();
		this.#timer = undefined;
	}
	async join(): Promise<void> {
		const runs = [...this.#runs.values()];
		for (const run of runs) run.controller.abort();
		await Promise.allSettled(runs.map((run) => run.done));
		if (!runs.length) return;
		await this.#options
			.writeAtClose(() =>
				runs.flatMap((run): StorageWrite[] => {
					const task = this.#tree.live.get(run.taskId);
					return task?.state.status === "running"
						? [{ type: "task", value: stateOf(task, { status: "pending", checkpoint: task.state.checkpoint }) }]
						: [];
				}),
			)
			.catch(() => {});
	}
	async waitForTask(id: TaskId, context: Context): Promise<SettledTask<JsonValue>> {
		const result = await this.#options.session.readOnLine(async () => {
			if (this.#closing) throw closedError(this.#options.session);
			if (this.#tree.live.has(id)) return { promise: this.#taskWaiters.add(id, context) };
			const task = await this.#options.storage.task(id, context);
			if (task === undefined) throw new Error(`Task ${id} does not exist`);
			return { promise: Promise.resolve(task as SettledTask<JsonValue>) };
		});
		return result.promise;
	}
	waitForIdle(id: ConversationId | undefined, context: Context): Promise<void> {
		if (this.#closing) return Promise.reject(closedError(this.#options.session));
		if (this.#tree.idle(id)) return Promise.resolve();
		this.#reconcileSoon();
		return this.#idleWaiters.add(id, context);
	}
	async abort(id: TaskId, context: Context, keepRestart = false): Promise<"marked" | "terminal"> {
		const result = await this.#options.session.commitWith(async (tx) => {
			const task = await tx.task(id);
			if (task === undefined) throw new Error(`Task ${id} does not exist`);
			if (task.state.status === "terminal") return { status: "terminal" as const };
			if (keepRestart && task.abortReason === "restart") return { status: "marked" as const };
			const run = this.#runs.get(id);
			if (run === undefined && task.state.status !== "completing") {
				await this.#load(false);
				if (!this.#tree.owned(id, undefined, true).length) {
					const resolved = this.#resolve(task as Runnable, this.#options.registry.snapshot());
					if ("reason" in resolved) {
						await this.#terminate(tx, task, { status: "orphaned", reason: resolved.reason });
						return { status: "marked" as const };
					}
				}
			}
			if (!task.abortRequested || task.abortReason !== undefined) tx.setTask(abortMark(task));
			return { status: "marked" as const, run: run?.mode === "run" ? run : undefined };
		}, context);
		if (result.run !== undefined)
			await awaitWithContext(Promise.race([result.run.done, this.#options.session.failed]), context);
		return result.status;
	}
	async abortConversation(id: ConversationId, background: boolean, context: Context): Promise<void> {
		const reached = await this.#options.session.commitWith(async (tx) => {
			const queued = await this.#load(true);
			await this.#tree.load(conversationNode(id));
			const tasks: TaskId[] = [];
			for (const child of this.#tree.descendants(conversationNode(id), { background })) {
				if (child.live === undefined || (child.node.background && !background)) continue;
				tasks.push(child.id);
				if (!child.live.abortRequested || child.live.abortReason !== undefined) tx.setTask(abortMark(child.live));
			}
			for (const conversation of queued)
				if (this.#tree.inScope(conversationNode(conversation), id, background) === true)
					await this.#options.withdrawInputs(tx, conversation);
			return tasks;
		}, context);
		if (background) for (const task of reached) await this.waitForTask(task, context);
		await this.waitForIdle(id, context);
	}
	#track(task: StoredTask): void {
		const old = this.#tree.live.get(task.id);
		const invocation = this.#runs.get(task.id);
		if (invocation) invocation.record = task as TaskRecord<JsonValue, Checkpoint, JsonValue>;
		if (task.state.status === "terminal") {
			if (old !== undefined && !this.#closing) this.#activeMetric.add(-1, { task: task.kind });
			this.#resumed.delete(task.id);
		} else if (old === undefined && !this.#closing) this.#activeMetric.add(1, { task: task.kind });
		if (old?.state.status === "waiting")
			for (const on of old.state.on) {
				const group = this.#dependents.get(on);
				group?.delete(task.id);
				if (!group?.size) this.#dependents.delete(on);
			}
		this.#tree.track(task);
		if (task.state.status === "terminal") {
			this.#ready.delete(task.id);
			this.#sleeping.delete(task.id);
			this.#cancelling.delete(task.id);
			this.#holders.delete(task.id);
			const above = this.#tree.nearest(task);
			if (above?.state.status === "completing") this.#holders.add(above.id);
			else if (above?.abortRequested) this.#ready.add(above.id);
			for (const dependent of this.#dependents.get(task.id) ?? []) this.#ready.add(dependent);
		} else {
			if (intent(task)) this.#cancelling.add(task.id);
			else this.#cancelling.delete(task.id);
			if (task.state.status === "completing") {
				this.#ready.delete(task.id);
				this.#holders.add(task.id);
			} else this.#ready.add(task.id);
			if (task.state.status === "sleeping") this.#sleeping.add(task.id);
			else this.#sleeping.delete(task.id);
			if (task.state.status === "waiting") {
				for (const on of task.state.on) {
					const group = this.#dependents.get(on) ?? new Set<TaskId>();
					group.add(task.id);
					this.#dependents.set(on, group);
				}
				if (task.state.policy === "failFast" && old?.state.status !== "waiting") this.#failFast.add(task.id);
			}
		}
	}
	#observe(publication: CommitPublication): void {
		for (const change of publication.changes)
			if (change.type === "conversation") this.#tree.conversation(change.value.id, change.value.owner?.taskId ?? null);
		let changed = false;
		for (const change of publication.changes) {
			if (
				change.type === "submission" &&
				change.value.status === "queued" &&
				change.value.type === "input" &&
				this.#cancelling.size
			)
				this.#cascade = true;
			if (change.type !== "task") continue;
			changed = true;
			const task = change.value,
				old = this.#tree.live.get(task.id);
			this.#track(task);
			if (failed(task) && (old === undefined || !failed(old)))
				for (const dependent of this.#dependents.get(task.id) ?? []) this.#failFast.add(dependent);
			if (task.state.status === "terminal") {
				this.#migrationFailures.delete(task.id);
				this.#failFast.delete(task.id);
				this.#taskWaiters.resolve(task.id, task as SettledTask<JsonValue>);
			} else {
				if (task.abortRequested && !old?.abortRequested) {
					this.#cascade = true;
					const run = this.#runs.get(task.id);
					if (run?.mode === "run") run.controller.abort();
				}
				if (old?.abortReason !== undefined && task.abortReason === undefined) this.#cascade = true;
				if (
					intent(task) ||
					(old === undefined &&
						(!this.#tree.known(taskParent(task)) || (!task.background && this.#cancelled(taskParent(task)))))
				)
					this.#cascade = true;
			}
		}
		if (this.#hasReconcileWork()) this.#reconcileSoon();
		this.#tree.prune();
		if (changed) {
			this.#settleIdle();
			this.#kick();
		}
	}
	async #load(queued: boolean): Promise<ConversationId[]> {
		await this.#tree.loadAll();
		this.#pruneSoon();
		if (!queued) return [];
		const submissions = await scanAll((cursor) =>
			this.#options.storage.scanSubmissions({ status: "queued" }, pageSize, cursor, this.#options.context),
		);
		const conversations = [...new Set(submissions.filter((s) => s.type === "input").map((s) => s.conversationId))];
		for (const id of conversations) await this.#tree.load(conversationNode(id));
		return conversations;
	}
	#pruneSoon(): void {
		if (this.#pruneQueued || this.#closing || !this.#tree.hasGarbage) return;
		this.#pruneQueued = true;
		this.#options.session
			.readOnLine(async () => {
				this.#pruneQueued = false;
				this.#tree.prune();
			})
			.catch(() => {});
	}
	#hasReconcileWork(): boolean {
		return this.#cascade || this.#holders.size > 0 || this.#failFast.size > 0;
	}
	#reconcileSoon(): void {
		if (this.#options.readOnly || this.#reconcileQueued || this.#closing) return;
		this.#reconcileQueued = true;
		queueMicrotask(() => void this.#reconcile());
	}
	async #reconcile(): Promise<void> {
		this.#reconcileQueued = false;
		const work = this.#hasReconcileWork(),
			cascade = this.#cascade;
		if (work) this.#reconcileCount++;
		this.#cascade = false;
		const checks = [...this.#failFast];
		this.#failFast.clear();
		try {
			await this.#options.session.commitWith(async (tx) => {
				if (this.#closing) return;
				const queued = await this.#load(cascade);
				const marks = new Map<TaskId, { task: StoredTask; reason: "restart" | undefined }>();
				const mark = (task: StoredTask, reason: "restart" | undefined) => {
					if (
						(marks.has(task.id) && marks.get(task.id)?.reason === undefined) ||
						(task.abortRequested && (task.abortReason === undefined || reason !== undefined))
					)
						return;
					marks.set(task.id, { task, reason });
				};
				for (const id of this.#cancelling) {
					const owner = this.#tree.live.get(id)!;
					for (const child of this.#tree.descendants(id, { enter: (below) => !this.#cancelling.has(below) })) {
						if (child.live && !child.node.background)
							mark(child.live, owner.abortReason === "restart" && !failed(owner) ? "restart" : undefined);
					}
				}
				for (const id of checks) {
					const task = this.#tree.live.get(id);
					if (task?.state.status !== "waiting" || task.state.policy !== "failFast") continue;
					let anyFailed = false;
					for (const id of task.state.on) {
						const member = this.#tree.live.get(id) ?? (await this.#options.storage.task(id, this.#options.context));
						if (member !== undefined && failed(member)) {
							anyFailed = true;
							break;
						}
					}
					if (!anyFailed) continue;
					for (const id of task.state.on) {
						const member = this.#tree.live.get(id);
						if (member !== undefined && !failed(member)) mark(member, undefined);
					}
				}
				for (const { task, reason } of marks.values()) tx.setTask(abortMark(task, reason));
				for (const id of queued) if (this.#cancelled(conversationNode(id))) await this.#options.withdrawInputs(tx, id);
				await this.#finalize(tx);
			}, this.#options.context);
		} catch (error) {
			this.#failSession(error);
		}
		if (work) this.#reconcileCount--;
		this.#scheduleWake();
		this.#settleIdle();
	}
	async #finalize(tx: Transaction): Promise<void> {
		let candidates = [...this.#holders];
		this.#holders.clear();
		const overlay = ownershipOverlay(tx),
			done = new Set<TaskId>();
		const tasks = new Map(overlay.tasks);
		const view = { ...overlay, tasks };
		while (candidates.length) {
			const next = new Set<TaskId>();
			for (const id of candidates) {
				const task = tasks.get(id) ?? this.#tree.live.get(id);
				if (task?.state.status !== "completing" || done.has(id) || this.#tree.owned(id, view, true, done).length)
					continue;
				const outcome = task.state.outcome,
					terminal = stateOf(task, { status: "terminal", outcome });
				tx.setTask(terminal);
				tasks.set(id, terminal);
				done.add(id);
				if (outcome.status === "faulted" || outcome.status === "orphaned")
					await this.#options.settleOutcome(tx, task, outcome);
				const parent = this.#tree.nearest(task, view);
				if (parent?.state.status === "completing") next.add(parent.id);
			}
			candidates = [...next];
		}
	}
	#failSession(error: unknown, context?: Context): void {
		if (!this.#closing) this.#options.session.fail(error, context);
	}
	#kick(): void {
		this.#scheduleWake();
		this.#dirty = true;
		if (this.#draining || !this.#enabled || this.#closing) return;
		this.#draining = true;
		queueMicrotask(() => void this.#drain());
	}
	async #drain(): Promise<void> {
		try {
			while (this.#dirty && this.#enabled && !this.#closing) {
				this.#dirty = false;
				for (const reservation of await this.#reserve()) this.#start(reservation);
			}
		} catch (error) {
			this.#failSession(error);
		} finally {
			this.#draining = false;
			if (this.#dirty && this.#enabled && !this.#closing) this.#kick();
		}
	}
	#resolve(
		task: Runnable,
		snapshot: RegistrySnapshot,
	): { task: AnyTask; record: Runnable } | { reason: BlockedReason } {
		const fit = this.#fit(task, snapshot.task(task.kind));
		if ("reason" in fit) return fit;
		if (!fit.migrates) return { task: fit.task, record: task };
		try {
			const def = definition(fit.task);
			if (def.migrate === undefined)
				throw new Error(`Task ${task.kind} version ${def.version} has no migration from ${task.version}`);
			const migrated = def.migrate(task.input, task.state.checkpoint, task.version);
			return {
				task: fit.task,
				record: {
					...task,
					version: def.version,
					input: copyJson(migrated.input),
					state: { ...task.state, checkpoint: copyJson(migrated.checkpoint) },
				} as Runnable,
			};
		} catch (error) {
			this.#migrationFailures.set(task.id, { task: fit.task, error });
			queueMicrotask(() => this.#notifyBlocked());
			this.#scheduleWake();
			this.#options.report(error, {
				type: "migration_failed",
				...this.#about({ ...recordIdentity(task), extension: installer(snapshot, fit.task) }),
			});
			return { reason: "migration_failed" };
		}
	}
	async #reserve(): Promise<Reservation[]> {
		const reservations: Reservation[] = [],
			faults: { task: StoredTask; error: Error }[] = [];
		const abandoned = [...this.#abandoned];
		try {
			await this.#options.session.commitWith(async (tx) => {
				if (!this.#enabled || this.#closing) return;
				if (abandoned.length) {
					for (const id of abandoned) {
						const task = this.#tree.live.get(id);
						if (task && !task.abortRequested) tx.setTask(abortMark(task, "restart"));
					}
					return;
				}
				await this.#load(false);
				this.#due();
				for (const id of this.#parked) {
					const task = this.#tree.live.get(id);
					if (task && this.#isParked(task)) continue;
					this.#parked.delete(id);
					if (task) {
						this.#ready.add(id);
						queueMicrotask(() => this.#notifyBlocked());
					}
				}
				let snapshot: RegistrySnapshot | undefined;
				for (const id of [...this.#ready]) {
					const task = this.#tree.live.get(id);
					if (
						task === undefined ||
						task.state.status === "completing" ||
						this.#runs.has(id) ||
						this.#waiting(task, true).length ||
						this.#notDue(task)
					) {
						this.#ready.delete(id);
						continue;
					}
					if (this.#isParked(task)) {
						this.#ready.delete(id);
						if (!this.#parked.has(id)) queueMicrotask(() => this.#notifyBlocked());
						this.#parked.add(id);
						continue;
					}
					if (!task.abortRequested && !task.background && this.#cancelled(taskParent(task))) {
						this.#cascade = true;
						this.#reconcileSoon();
						continue;
					}
					if (task.abortRequested && (task.restarts ?? 0) >= this.#restartLimit()) {
						const error = new Error(`Abort handler of task ${id} (${task.kind}) was cut off ${task.restarts} times`);
						await this.#terminate(tx, task, {
							status: "faulted",
							error: { message: error.message, detail: { reason: "restart_limit" } },
						});
						faults.push({ task, error });
						continue;
					}
					snapshot ??= this.#options.registry.snapshot();
					const resolved = this.#resolve(task as Runnable, snapshot);
					if ("reason" in resolved) {
						if (task.abortRequested && task.abortReason === undefined)
							await this.#terminate(tx, task, { status: "orphaned", reason: resolved.reason });
						continue;
					}
					if (resolved.record !== task || task.state.status !== "running")
						tx.setTask(stateOf(resolved.record, { status: "running", checkpoint: resolved.record.state.checkpoint }));
					const controller = new AbortController(),
						completion = Promise.withResolvers<void>();
					const invocation: Invocation = {
						taskId: id,
						kind: task.kind,
						conversationId: task.conversationId,
						extension: installer(snapshot, resolved.task),
						mode: task.abortRequested ? "abort" : "run",
						controller,
						links: resolved.record.startedAt === undefined ? resolved.record.links : undefined,
						record: resolved.record as TaskRecord<JsonValue, Checkpoint, JsonValue>,
						context: withAbortSignal(controller.signal, this.#options.context),
						watches: new Set(),
						timers: new Set(),
						done: completion.promise,
						finish: completion.resolve,
						ended: false,
					};
					this.#runs.set(id, invocation);
					this.#ready.delete(id);
					reservations.push({ invocation, task: resolved.task, snapshot });
				}
			}, this.#options.context);
		} catch (error) {
			for (const { invocation } of reservations) {
				this.#runs.delete(invocation.taskId);
				this.#ready.add(invocation.taskId);
				invocation.finish();
			}
			throw error;
		}
		for (const { task, error } of faults)
			this.#options.report(error, {
				type: "task_faulted",
				...this.#about(recordIdentity(task)),
				reason: "restart_limit",
			});
		for (const id of abandoned) this.#abandoned.delete(id);
		if (abandoned.length) this.#dirty = true;
		return reservations;
	}
	#start(reservation: Reservation): void {
		void this.#execute(reservation)
			.catch((error) =>
				this.#options.report(
					error,
					{ type: "task_error", ...this.#about(reservation.invocation) },
					reservation.invocation.context,
				),
			)
			.finally(() => {
				this.#end(reservation.invocation);
				reservation.invocation.record = undefined;
				reservation.invocation.links = undefined;
				reservation.invocation.fault = undefined;
				reservation.invocation.finish();
				this.#kick();
			});
	}
	async #execute({ invocation: run, task, snapshot }: Reservation): Promise<void> {
		const phase: Phase = { task, snapshot },
			runtime = this.#runtime(run, phase);
		if (run.mode === "abort") {
			const current = this.#tree.live.get(run.taskId);
			if (current?.state.status !== "running" || this.#closing) return;
			await this.#phase(run, current as Running, async () => {
				let failure: { error: unknown } | undefined;
				try {
					await definition(task).abort(current as Running, runtime, run.context);
				} catch (error) {
					failure = { error };
				}
				await this.#step(run, () => ({
					fault: failure?.error ?? new Error(`Abort handler of task ${run.taskId} returned without a terminal outcome`),
				}));
			});
			return;
		}
		const decide =
			(previous: Previous | undefined) =>
			(tx: Transaction, current: Running): boolean | { fault: unknown } => {
				if (current.abortRequested) return false;
				if (!current.background && this.#cancelled(taskParent(current))) {
					this.#cascade = true;
					this.#reconcileSoon();
					return false;
				}
				if (previous === undefined) return true;
				if (previous.failure) return { fault: previous.failure.error };
				if (equal(current.state.checkpoint, previous.checkpoint))
					return {
						fault: new Error(
							`Task ${current.kind} phase ${previous.checkpoint.phase} returned without durable progress`,
						),
					};
				phase.snapshot = this.#options.registry.snapshot();
				const replacement = phase.snapshot.task(current.kind);
				if (replacement !== phase.task) {
					if (
						replacement !== undefined &&
						(replacement.definition.version === current.version ||
							(replacement.definition.version > current.version && replacement.definition.migrate !== undefined))
					) {
						tx.setTask(stateOf(current, { status: "pending", checkpoint: current.state.checkpoint }));
						return false;
					}
					if (phase.reported === undefined || phase.reported.task !== replacement) {
						phase.reported = { task: replacement };
						this.#options.report(
							new Error(`Task ${current.id} keeps running under its old ${current.kind} definition`),
							{
								type: "task_outdated",
								...this.#about(run),
								reason: replacement === undefined ? "missing_task" : "incompatible_task",
							},
							run.context,
						);
					}
				}
				return true;
			};
		let current = await this.#step(run, decide(undefined));
		while (current !== undefined && !this.#closing) {
			const task = current;
			current = await this.#phase(run, task, async () => {
				phase.agent = undefined;
				const checkpoint = task.state.checkpoint;
				let previous: Previous;
				try {
					await definition(phase.task).phases[checkpoint.phase]!(task, runtime, run.context);
					previous = { checkpoint };
				} catch (error) {
					previous = { checkpoint, failure: { error } };
				}
				return this.#step(run, decide(previous));
			});
		}
	}
	#phase<T>(run: Invocation, task: Running, invoke: () => Promise<T>): Promise<T> {
		const parent =
			task.trace === undefined
				? this.#telemetry
				: (this.#telemetry.propagation?.extract(task.trace) ?? this.#telemetry);
		const checkpoint = task.state.checkpoint;
		const resumed = this.#resumed.delete(task.id);
		return createTypedSpanStarter(parent, [DURABLE_TELEMETRY_SCHEMA])(
			"axi.durable.phase",
			{
				"task.id": task.id,
				"task.name": task.kind,
				phase: checkpoint.phase,
				kind: run.mode,
				resumed,
				...(checkpoint.attempt === undefined ? {} : { attempt: checkpoint.attempt }),
			},
			async (span) => {
				if (span.propagation && run.links !== undefined)
					for (const carrier of run.links) span.addLink({ context: span.propagation.extract(carrier) });
				const previous = run.context;
				run.context = withTelemetry(span, previous);
				const started = performance.now();
				try {
					return await invoke();
				} finally {
					run.context = previous;
					const state = run.record!.state;
					const terminal =
						run.fault ?? (state.status === "terminal" || state.status === "completing" ? state.outcome : undefined);
					const outcome =
						terminal !== undefined
							? terminal.status === "completed"
								? "done"
								: terminal.status === "aborted"
									? "aborted"
									: "faulted"
							: state.status === "waiting" || state.status === "sleeping"
								? state.status
								: run.ended || this.#closing
									? "aborted"
									: `next=${state.checkpoint!.phase}`;
					span.setAttributes({ outcome });
					if (terminal?.status === "faulted" || terminal?.status === "failed" || terminal?.status === "orphaned") {
						span.setStatus({
							status: "error",
							error: {
								name: `task_${terminal.status}`,
								message: (terminal.status === "orphaned" ? terminal.reason : terminal.error.message).slice(0, 500),
							},
						});
					} else if (outcome === "aborted") span.setStatus({ status: "ok" });
					this.#durationMetric.record(
						performance.now() - started,
						{ task: task.kind, phase: checkpoint.phase, outcome },
						span,
					);
				}
			},
		);
	}
	async #step(
		run: Invocation,
		decide: (tx: Transaction, task: Running) => boolean | { fault: unknown },
	): Promise<Running | undefined> {
		let fault: { error: unknown } | undefined;
		try {
			const next = await this.#options.session.commitWith(async (tx) => {
				const record = this.#tree.live.get(run.taskId);
				const current = record?.state.status === "running" ? (record as Running) : undefined;
				const choice = current !== undefined && !this.#closing ? decide(tx, current) : false;
				if (choice === true) return current;
				this.#end(run);
				if (choice !== false) {
					fault = { error: choice.fault };
					run.fault = { status: "faulted", error: { message: errorMessage(choice.fault) } };
					await this.#terminate(tx, current!, run.fault);
				}
			}, withoutAbortSignal(run.context));
			if (fault !== undefined)
				this.#options.report(fault.error, { type: "task_faulted", ...this.#about(run), reason: "threw" }, run.context);
			return next;
		} catch (error) {
			this.#end(run);
			this.#failSession(error, run.context);
		}
	}
	async #terminate(tx: Transaction, task: StoredTask, outcome: SchedulerOutcome): Promise<void> {
		await this.#load(false);
		if (this.#tree.owned(task.id, ownershipOverlay(tx), true).length)
			tx.setTask(stateOf(task, { status: "completing", outcome }));
		else {
			tx.setTask(stateOf(task, { status: "terminal", outcome }));
			await this.#options.settleOutcome(tx, task, outcome);
		}
	}
	#end(run: Invocation): void {
		if (run.ended) return;
		run.ended = true;
		if (this.#runs.get(run.taskId) === run) {
			this.#runs.delete(run.taskId);
			if (this.#tree.live.has(run.taskId)) this.#ready.add(run.taskId);
		}
		for (const watch of run.watches) void watch.stop();
		for (const cancel of run.timers) cancel();
		run.timers.clear();
		run.controller.abort(ended(run));
	}
	async #validateWait(
		tx: Transaction,
		run: Invocation,
		current: Running,
		on: readonly TaskId[],
		policy: string,
	): Promise<void> {
		if (run.mode === "abort") throw new Error(`Abort handler of task ${current.id} cannot wait`);
		const overlay = ownershipOverlay(tx),
			targets: TaskId[] = [];
		for (const id of on) {
			const task =
				overlay.tasks.get(id) ??
				this.#tree.live.get(id) ??
				(await this.#options.storage.task(id, this.#options.context));
			if (task === undefined) throw new Error(`Task ${id} does not exist`);
			if (policy === "failFast" && task.owner !== current.id)
				throw new Error(`Task ${current.id} can wait failFast only on tasks it owns; ${id} is not one`);
			if (task.state.status !== "terminal" && task.owner !== current.id) targets.push(id);
		}
		if (!targets.length) return;
		await this.#load(false);
		const via = new Map<TaskId, TaskId | undefined>(),
			stack: TaskId[] = [],
			walked = new Set<TaskId>();
		const reach = (id: TaskId, parent: TaskId | undefined) => {
			if (!via.has(id)) {
				via.set(id, parent);
				stack.push(id);
			}
		};
		for (const id of targets) reach(id, undefined);
		for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
			if (id === current.id) {
				const path: TaskId[] = [];
				for (let step: TaskId | undefined = id; step !== undefined; step = via.get(step)) path.unshift(step);
				throw new Error(
					`Task ${current.id} cannot wait on ${path[0]}: ${[current.id, ...path].join(" -> ")} is a wait cycle`,
				);
			}
			const task = overlay.tasks.get(id) ?? this.#tree.live.get(id);
			if (task === undefined || task.state.status === "terminal") continue;
			if (task.state.status === "waiting" && !task.abortRequested)
				for (const member of task.state.on) reach(member, id);
			if (walked.has(id)) continue;
			walked.add(id);
			const visited: TaskId[] = [];
			for (const child of this.#tree.descendants(id, { overlay, enter: (below) => !walked.has(below) }))
				if (child.live && !child.node.background) {
					reach(child.id, id);
					visited.push(child.id);
				}
			for (const child of visited) walked.add(child);
		}
	}
	async #commitState(
		tx: Transaction,
		run: Invocation,
		current: Running,
		next: NextTaskState<Checkpoint, JsonValue>,
	): Promise<void> {
		if (next.status === "waiting") await this.#validateWait(tx, run, current, next.on, next.policy);
		if (next.status === "sleeping") {
			if (run.mode === "abort") throw new Error(`Abort handler of task ${current.id} cannot sleep`);
			if (typeof next.until !== "number" || !Number.isFinite(next.until) || next.until < 0)
				throw new Error(`Task ${current.id} cannot sleep until ${next.until}: not a time in milliseconds`);
		}
		if (next.status === "terminal") {
			const overlay = ownershipOverlay(tx);
			await this.#load(false);
			for (const task of overlay.tasks.values()) await this.#tree.load(taskParent(task), overlay);
			if (this.#tree.owned(current.id, overlay, true).length) {
				tx.setTask(stateOf(progress(current), { status: "completing", outcome: next.outcome }));
				return;
			}
		}
		tx.setTask(stateOf(equal(current.state, next) ? current : progress(current), next));
	}
	#gated<T>(
		run: Invocation,
		change: (tx: Transaction, current: Running) => T | Promise<T>,
		context: Context,
	): Promise<T> {
		if (run.ended) return Promise.reject(ended(run));
		return this.#options.session.commitWith(
			async (tx) => {
				if (run.ended) throw ended(run);
				if (this.#closing) throw closedError(this.#options.session);
				const task = this.#tree.live.get(run.taskId);
				if (task?.state.status !== "running")
					throw new Error(`Task ${run.taskId} is ${task?.state.status ?? "terminal"}`);
				if (run.mode === "run" && task.abortRequested) throw new Error(`Task ${run.taskId} has a durable abort mark`);
				return change(tx, task as Running);
			},
			context,
			{ conversationId: run.conversationId, taskId: run.taskId },
		);
	}
	#read<T>(run: Invocation, read: () => Promise<T>): Promise<T> {
		return run.ended ? Promise.reject(ended(run)) : read();
	}
	async #watch(run: Invocation, args: readonly unknown[]): Promise<DocumentWatch<JsonObject> | undefined> {
		if (run.ended) throw ended(run);
		const watch = (await forward(this.#options.session, "watchDoc", args)) as DocumentWatch<JsonObject> | undefined;
		if (watch === undefined) return;
		if (run.ended) {
			void watch.stop();
			throw ended(run);
		}
		run.watches.add(watch);
		void watch.closed.then(() => run.watches.delete(watch));
		return watch;
	}
	#runtime(run: Invocation, phase: Phase): Runtime {
		const o = this.#options;
		const agent = (): Promise<Agent> => {
			if (run.ended) return Promise.reject(ended(run));
			if (phase.agent === undefined) {
				phase.agent = o.agent(run.conversationId, phase.snapshot, run.context);
				phase.agent.catch(() => {});
			}
			return phase.agent;
		};
		const hooks: HookRunner<Record<string, unknown>> = {
			each: async (name, invoke) => {
				for (const { extension, handlers } of agentHooks(await agent(), phase.task.definition.name)) {
					const handler = Reflect.get(handlers, name);
					if (typeof handler !== "function") continue;
					try {
						await invoke(handler.bind(handlers));
					} catch (error) {
						if (run.controller.signal.aborted) throw error;
						o.report(error, { type: "extension_error", extension, task: identity(run) }, run.context);
					}
				}
			},
		};
		const runtime: Runtime = {
			taskId: run.taskId as TaskId<JsonValue>,
			conversationId: run.conversationId,
			signal: run.controller.signal,
			get registry() {
				return phase.snapshot;
			},
			get models() {
				return o.models();
			},
			get settings() {
				return o.settings();
			},
			agent: (context) => (run.ended ? Promise.reject(ended(run)) : awaitWithContext(agent(), context)),
			env: (context) => this.#read(run, () => o.env(run.conversationId, context)),
			hooks,
			commit: async (change, context) => {
				let checkpoint: string | undefined;
				await this.#gated(
					run,
					async (tx, current) => {
						const next = await change(tx, current);
						if (next !== undefined) await this.#commitState(tx, run, current, next);
						if (next?.status === "running" && next.checkpoint.phase !== current.state.checkpoint.phase)
							checkpoint = next.checkpoint.phase;
					},
					context,
				);
				if (checkpoint !== undefined) run.context.telemetry.addEvent("axi.durable.checkpoint", { phase: checkpoint });
			},
			memo: ((key: string, ...args: readonly unknown[]) =>
				args.length === 1
					? this.#read(run, async () => memo(this.#tree.live.get(run.taskId), key))
					: this.#gated(
							run,
							(tx, task) => {
								const winner = memo(task, key);
								if (winner !== undefined) return winner;
								const candidate = args[0] as JsonValue;
								tx.setTask({ ...task, memos: { ...task.memos, [key]: candidate } });
								return candidate;
							},
							args[1] as Context,
						)) as Runtime["memo"],
			sleepUntil: (until, checkpoint, context) =>
				this.#gated(
					run,
					(tx, current) => this.#commitState(tx, run, current, { status: "sleeping", until, checkpoint }),
					context,
				),
			watchDoc: ((...args: readonly unknown[]) => this.#watch(run, args)) as Runtime["watchDoc"],
			snapshot: ((...args: readonly unknown[]) =>
				this.#read(run, () => forward(o.session, "snapshot", args))) as Runtime["snapshot"],
			snapshotAsOf: ((...args: readonly unknown[]) =>
				this.#read(run, () => forward(o.session, "snapshotAsOf", args))) as Runtime["snapshotAsOf"],
			getTask: ((id: TaskId, context: Context) =>
				this.#read(run, () => o.session.readOnLine(() => o.storage.task(id, context)))) as Runtime["getTask"],
			waitForTask: ((id: TaskId, context: Context) =>
				this.#read(run, () =>
					this.waitForTask(id, withAbortSignal(run.controller.signal, context)),
				)) as Runtime["waitForTask"],
			ownedTasks: (context) =>
				this.#read(run, () =>
					o.session.readOnLine(async () => {
						if (run.ended) throw ended(run);
						context.abortSignal?.throwIfAborted();
						return this.#tree
							.direct(run.taskId)
							.map((task) => copyJson(task as unknown as JsonValue) as unknown as StoredTask);
					}),
				),
			abortOwned: (id, context) =>
				this.#read(run, async () => {
					const bound = withAbortSignal(run.controller.signal, context),
						task = await o.session.readOnLine(() => o.storage.task(id, bound));
					if (task?.owner !== run.taskId) throw new Error(`Task ${id} is not owned by task ${run.taskId}`);
					if (task.state.status === "terminal") return;
					await this.abort(id, bound, true);
					await this.waitForTask(id, bound);
				}),
			outcomes: ((ids: readonly TaskId[], context: Context) =>
				this.#read(run, () =>
					o.session.readOnLine(async () => {
						const outcomes: TaskOutcome<JsonValue>[] = [];
						for (const id of ids) {
							const state = (await o.storage.task(id, context))?.state;
							if (state?.status !== "terminal") throw new Error(`Task ${id} is not terminal`);
							outcomes.push(state.outcome);
						}
						return outcomes;
					}),
				)) as Runtime["outcomes"],
			conversation: (id, context) =>
				this.#read(run, () =>
					o.conversation(
						id,
						{
							signal: run.controller.signal,
							check: () => {
								if (run.ended) throw ended(run);
							},
						},
						context,
					),
				),
			entry: ((first: EntryId | Entry<JsonValue>, second: EntryId | Context, third?: Context) =>
				this.#read(run, async () => {
					const id = typeof first === "number" ? first : (second as EntryId),
						context = typeof first === "number" ? (second as Context) : third!;
					const found = await o.session.readOnLine(() => o.storage.entry(run.conversationId, id, context));
					return typeof first === "number" || found?.entry.kind === first.kind ? found?.entry : undefined;
				})) as Runtime["entry"],
			context: (id, context, options) =>
				this.#read(run, async () => {
					const { view, range } = await readContextFrom(
						o.session,
						o.storage,
						id,
						context,
						options?.at,
						this.#contexts.get(id)?.range,
					);
					const kept = this.#contexts.get(id);
					if (
						range &&
						!this.#closing &&
						!run.ended &&
						(kept === undefined || kept.range.bounds.tail <= range.bounds.tail)
					) {
						if (!this.#tree.idle(id)) this.#contexts.set(id, { range, idleSince: undefined });
						else if (this.#retention() > 0) {
							this.#contexts.set(id, { range, idleSince: kept?.idleSince ?? o.now() });
							this.#scheduleExpiry();
						}
					}
					return view;
				}),
			now: () => {
				if (run.ended) throw ended(run);
				return o.now();
			},
			setTimer: (callback, delay) => {
				if (run.ended) return () => {};
				const cancel = o.timers.foreground(() => {
					run.timers.delete(cancel);
					if (!run.ended) callback();
				}, delay);
				run.timers.add(cancel);
				return () => {
					run.timers.delete(cancel);
					cancel();
				};
			},
			report: (error, from) => {
				if (run.ended) throw ended(run);
				o.report(
					error,
					from === undefined
						? { type: "task_error", ...this.#about(run) }
						: from.type === "extension"
							? { type: "extension_error", task: identity(run), ...optionalExtension(from.extension) }
							: { type: "host_error", callback: from.callback, task: identity(run) },
					run.context,
				);
			},
		};
		return runtime;
	}
	#retention(): number {
		try {
			return this.#options.settings().contextRetentionMs;
		} catch (error) {
			this.#hostError(error, "settings");
			return 0;
		}
	}
	#settleIdle(): void {
		for (const id of this.#idleWaiters.keys()) if (this.#tree.idle(id)) this.#idleWaiters.resolve(id);
		const now = this.#options.now(),
			retention = this.#retention();
		for (const [id, kept] of this.#contexts) {
			if (kept.idleSince !== undefined && now - kept.idleSince >= retention) this.#contexts.delete(id);
			else if (!this.#tree.idle(id)) kept.idleSince = undefined;
			else if (retention > 0) kept.idleSince ??= now;
			else this.#contexts.delete(id);
		}
		this.#scheduleExpiry();
	}
	#scheduleExpiry(): void {
		const retention = this.#retention();
		let at: number | undefined;
		for (const kept of this.#contexts.values())
			if (kept.idleSince !== undefined && (at === undefined || kept.idleSince + retention < at))
				at = kept.idleSince + retention;
		if (this.#expiry?.at === at) return;
		this.#expiry?.cancel();
		this.#expiry = undefined;
		if (at === undefined || this.#closing) return;
		const cancel = this.#options.timers.background(() => {
			this.#expiry = undefined;
			this.#settleIdle();
		}, at - this.#options.now());
		if (cancel !== undefined) this.#expiry = { at, cancel };
	}
	get indexSizes() {
		return this.#tree.sizes;
	}
	async inspect(
		snapshot: RegistrySnapshot,
	): Promise<{ scheduling: HarnessInspection["scheduling"]; tasks: TaskInspection[] }> {
		await this.#load(false);
		const tasks: TaskInspection[] = [];
		for (const record of this.#tree.live.values()) {
			let state: TaskInspection["state"];
			const on = this.#waiting(record);
			if (this.#runs.has(record.id)) state = { kind: "running" };
			else if (record.state.status === "completing") state = { kind: "completing" };
			else if (on.length) state = { kind: "waiting", on };
			else if (this.#notDue(record)) state = { kind: "sleeping", until: record.state.until };
			else if (this.#isParked(record)) state = { kind: "blocked", reason: "restart_limit" };
			else {
				const fit = this.#fit(record, snapshot.task(record.kind));
				if ("reason" in fit) state = { kind: "blocked", ...fit };
				else if (fit.migrates && fit.task.definition.migrate === undefined)
					state = {
						kind: "blocked",
						reason: "migration_failed",
						error: new Error(
							`Task ${record.kind} version ${fit.task.definition.version} has no migration from ${record.version}`,
						),
					};
				else state = { kind: "ready", migrates: fit.migrates };
			}
			tasks.push({ record, state });
		}
		return { scheduling: this.#closing ? "closing" : this.#enabled ? "running" : "paused", tasks };
	}
}

function forward(
	session: SessionImpl,
	method: "snapshot" | "snapshotAsOf" | "watchDoc",
	args: readonly unknown[],
): Promise<unknown> {
	return (session[method] as (...args: readonly unknown[]) => Promise<unknown>).call(session, ...args);
}
