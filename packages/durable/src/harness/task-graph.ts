import type { Observer as StateObserver, Observation } from "../types.ts";
import { GuardedObserver } from "../session/observer.ts";
import { type Context, type JsonValue, Watch, type WatchCall } from "@axi/objects";
import { BACKGROUND_CONTEXT, withoutAbortSignal } from "@axi/objects/context";
import { applyImmutable, type Op } from "@axi/objects/delta";
import { contained, NORMAL_END, sessionObserverEnd, type SessionImpl } from "../session/session.ts";
import type {
	CommitPublication,
	ConversationId,
	JoinPolicy,
	Storage,
	TaskId,
	TaskOutcome,
	TaskRecord,
	WatchHandle,
} from "../types.ts";
import { type BlockedReason, type BlockedSubject, blockedSubject } from "./scheduler.ts";
import { jsonEqual } from "./json.ts";
import { closedError, scanAll } from "./util.ts";

export type TaskGraphState =
	| { readonly status: "pending" | "running"; readonly phase: string }
	| { readonly status: "waiting"; readonly phase: string; readonly on: readonly TaskId[]; readonly policy: JoinPolicy }
	| { readonly status: "sleeping"; readonly phase: string; readonly until: number }
	| { readonly status: "completing"; readonly outcome: TaskOutcome<JsonValue>["status"] };
export type TaskGraphNode = {
	readonly id: TaskId;
	readonly kind: string;
	readonly conversationId: ConversationId;
	readonly owner?: TaskId;
	readonly background: boolean;
	readonly abortRequested: boolean;
	readonly state: TaskGraphState;
	readonly blocked?: BlockedReason;
	readonly conversations: readonly ConversationId[];
};
export type TaskGraph = { readonly tasks: Readonly<Record<string, TaskGraphNode>> };
export type TaskGraphWatch = WatchHandle<TaskGraph>;
export type TaskGraphBlocking = {
	readonly blocked: (record: BlockedSubject) => BlockedReason | undefined;
	readonly subscribeBlocked: (listener: () => void) => () => void;
};
type StoredTask = TaskRecord<JsonValue, JsonValue, JsonValue>;
type Observer = StateObserver<TaskGraph>;
type Mount = { value: TaskGraph; observers: Set<Observer>; records: Map<string, BlockedSubject> };

export class TaskGraphView {
	readonly #session: SessionImpl;
	readonly #blocking: TaskGraphBlocking;
	#mount: Mount | undefined;
	#closed = false;
	constructor(session: SessionImpl, blocking: TaskGraphBlocking) {
		this.#session = session;
		this.#blocking = blocking;
		session.followCommits((publication, context) => {
			if (this.#mount) advance(this.#mount, publication, context, blocking.blocked, (error) => session.report(error));
		});
		blocking.subscribeBlocked(() => this.#refresh());
		session.subscribeClose(() => {
			this.#closed = true;
			const observerEnd = sessionObserverEnd(session.failure);
			const watchEnd = session.failure === undefined ? NORMAL_END : observerEnd;
			for (const observer of [...(this.#mount?.observers ?? [])])
				contained(
					() => observer.end(observer instanceof Watch ? watchEnd : observerEnd),
					(error) => session.report(error),
				);
			this.#mount = undefined;
		});
	}
	async observe(target: Observer, context: Context): Promise<Observation<TaskGraph>> {
		let value!: TaskGraph;
		const { observer, detach } = await this.#attach((current, release) => {
			value = current;
			return new GuardedObserver(target, release, (error) => this.#session.report(error));
		}, context);
		if (context.abortSignal?.aborted) {
			detach();
			throw context.abortSignal.reason;
		}
		return observedGraph(value, observer);
	}
	async watch(context: Context): Promise<TaskGraphWatch> {
		const { observer } = await this.#attach(
			(value, release) => new Watch<TaskGraph>(value, release, (error) => this.#session.report(error)),
			context,
		);
		const signal = context.abortSignal;
		if (signal?.aborted) {
			observer.abort();
			throw signal.reason;
		}
		if (signal !== undefined) observer.observeAbort(signal);
		return observer;
	}
	#attach<O extends Observer>(
		create: (value: TaskGraph, release: () => void) => O,
		context: Context,
	): Promise<{ observer: O; detach: () => void }> {
		return this.#session.readOnLine(async (storage) => {
			const mount = this.#mount ?? { ...(await this.#build(storage, context)), observers: new Set<Observer>() };
			const detach = () => {
				mount.observers.delete(observer);
				if (!mount.observers.size && this.#mount === mount) this.#mount = undefined;
			};
			const observer = create(mount.value, detach);
			if (this.#closed) throw closedError(this.#session);
			context.abortSignal?.throwIfAborted();
			this.#mount = mount;
			mount.observers.add(observer);
			return { observer, detach };
		});
	}
	#refresh(): void {
		if (this.#mount === undefined || this.#closed) return;
		this.#session
			.readOnLine(async () => {
				const mount = this.#mount;
				if (mount === undefined) return;
				const ops: Op[] = [];
				for (const [key, record] of mount.records) {
					const reason = this.#blocking.blocked(record);
					if (reason !== mount.value.tasks[key]?.blocked)
						ops.push(
							reason === undefined ? ["d", ["tasks", key, "blocked"]] : ["s", ["tasks", key, "blocked"], reason],
						);
				}
				publish(mount, ops, BACKGROUND_CONTEXT, (error) => this.#session.report(error));
			})
			.catch(() => {});
	}
	async #build(storage: Storage, context: Context): Promise<Omit<Mount, "observers">> {
		const tasks: { [key: string]: TaskGraphNode } = {},
			records = new Map<string, BlockedSubject>(),
			stored: StoredTask[] = [];
		for (const status of ["pending", "running", "waiting", "sleeping", "completing"] as const)
			stored.push(...(await scanAll((cursor) => storage.scanTasks({ status }, 256, cursor, context))));
		stored.sort((left, right) => left.id - right.id);
		for (const record of stored) {
			const conversations = (
					await scanAll((cursor) => storage.scanConversations({ ownerTaskId: record.id }, 256, cursor, context))
				)
					.map((record) => record.id)
					.sort((left, right) => left - right),
				subject = blockedSubject(record),
				key = String(record.id);
			tasks[key] = node(record, conversations, this.#blocking.blocked(subject));
			records.set(key, subject);
		}
		return { value: { tasks }, records };
	}
}
function state(record: StoredTask): TaskGraphState {
	const value = record.state;
	switch (value.status) {
		case "pending":
		case "running":
			return { status: value.status, phase: (value.checkpoint as { phase: string }).phase };
		case "waiting":
			return {
				status: "waiting",
				phase: (value.checkpoint as { phase: string }).phase,
				on: [...value.on],
				policy: value.policy,
			};
		case "sleeping":
			return { status: "sleeping", phase: (value.checkpoint as { phase: string }).phase, until: value.until };
		case "completing":
		case "terminal":
			return { status: "completing", outcome: value.outcome.status };
	}
}
function node(
	record: StoredTask,
	conversations: readonly ConversationId[],
	blocked: BlockedReason | undefined,
): TaskGraphNode {
	return {
		id: record.id,
		kind: record.kind,
		conversationId: record.conversationId,
		...(record.owner === undefined ? {} : { owner: record.owner }),
		background: record.background,
		abortRequested: record.abortRequested,
		state: state(record),
		conversations,
		...(blocked === undefined ? {} : { blocked }),
	};
}
function advance(
	mount: Mount,
	publication: Pick<CommitPublication, "changes">,
	context: Context,
	blocked: TaskGraphBlocking["blocked"],
	report: (error: unknown) => void,
): void {
	const ops: Op[] = [],
		changed = new Map<string, TaskGraphNode | undefined>();
	const current = (key: string) => (changed.has(key) ? changed.get(key) : mount.value.tasks[key]);
	for (const change of publication.changes) {
		if (change.type !== "task") continue;
		const record = change.value,
			key = String(record.id),
			previous = current(key);
		if (record.state.status === "terminal") {
			mount.records.delete(key);
			if (previous !== undefined) {
				ops.push(["d", ["tasks", key]]);
				changed.set(key, undefined);
			}
		} else {
			const subject = blockedSubject(record);
			mount.records.set(key, subject);
			const next = node(record, previous?.conversations ?? [], blocked(subject));
			if (previous !== undefined && jsonEqual(previous, next)) continue;
			ops.push(["s", ["tasks", key], next as unknown as JsonValue]);
			changed.set(key, next);
		}
	}
	const conversations = new Map<string, ConversationId[]>();
	for (const change of publication.changes)
		if (change.type === "conversation" && change.value.owner !== undefined) {
			const key = String(change.value.owner.taskId);
			if (current(key) !== undefined) conversations.set(key, [...(conversations.get(key) ?? []), change.value.id]);
		}
	for (const [key, ids] of conversations)
		ops.push([
			"s",
			["tasks", key, "conversations"],
			[...current(key)!.conversations, ...ids].sort((left, right) => left - right),
		]);
	publish(mount, ops, context, report);
}
function publish(mount: Mount, ops: Op[], context: Context, report: (error: unknown) => void): void {
	if (!ops.length) return;
	mount.value = applyImmutable(mount.value, ops);
	const frame = withoutAbortSignal(context);
	const call: WatchCall<TaskGraph> = { kind: "value", value: mount.value, ops, retired: false };
	for (const observer of [...mount.observers])
		contained(() => observer.advance(call, frame), report);
}

function observedGraph(value: TaskGraph, observer: { detach(): void }): Observation<TaskGraph> {
	return { value, detach: () => observer.detach() };
}
