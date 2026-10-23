import { type Context, type JsonValue, Watch } from "@axi/chord";
import type { Op, Path } from "@axi/chord/delta";
import type { AssistantMessage, Message, Usage } from "@axi/ai";
import type {
	CommitPublication,
	ConversationId,
	EntryRecord,
	JsonObject,
	SubmissionId,
	SubmissionRecord,
	TaskId,
	TaskRecord,
	WatchEnd,
} from "../types.ts";
import { AgentDoc } from "./agent.ts";
import { InboxDoc, type InboxItem, type InboxState } from "./inbox.ts";
import {
	LiveDoc,
	type CompactionFailure,
	type CompactionStatus,
	type LiveState,
	type NestedToolSlot,
	type ToolSlot,
} from "./live.ts";
import { NestedCallDoc, type NestedCallState } from "./tool.ts";
import type { AgentState, CompactionReason, Harness, NestedToolExecutionResult, ToolDiagnostic } from "./types.ts";
import { UsageDoc, type UsageState } from "./usage.ts";
import { scanAll } from "./util.ts";
import { type ConversationView, conversationViews } from "./view.ts";

type Block = AssistantMessage["content"][number];
type QueuedItem = { id: SubmissionId; mode: InboxItem["mode"] };
export type MessageChange =
	| { type: "text_start" | "thinking_start" | "toolcall_start"; contentIndex: number; block: Block }
	| { type: "text_delta" | "thinking_delta"; contentIndex: number; delta: string }
	| { type: "toolcall_delta"; contentIndex: number; path: readonly (string | number)[]; delta: string }
	| { type: "block"; contentIndex: number; block: Block }
	| { type: "message"; message: AssistantMessage };
export type SnapshotEvent = {
	type: "snapshot";
	entries: readonly EntryRecord[];
	run?: { inputs: readonly SubmissionId[] };
	generation?: {
		attempt: number;
		message?: AssistantMessage;
		retry?: { at: number; error: string };
		deferred?: { pollAt: number };
	};
	tools: readonly ToolSlot[];
	nestedTools: readonly NestedToolSlot[];
	compactions: readonly CompactionStatus[];
	compactionFailure?: CompactionFailure;
	inbox: readonly QueuedItem[];
	agent: AgentState;
	usage: UsageState;
};
export type ToolEventCall = {
	toolCallId: string;
	toolName: string;
	taskId?: TaskId;
	parentToolCallId?: string;
	parentTaskId?: TaskId;
};
export type AgentEvent =
	| SnapshotEvent
	| { type: "run_start"; inputs: readonly SubmissionId[] }
	| { type: "run_end"; inputs: readonly SubmissionId[] }
	| { type: "turn_start" }
	| { type: "turn_end" }
	| { type: "message_start"; message: Message }
	| { type: "message_update"; usage: Usage; changes: readonly MessageChange[] }
	| { type: "message_end"; entry: EntryRecord }
	| ({ type: "tool_execution_start"; args: JsonObject } & ToolEventCall)
	| ({
			type: "tool_execution_update";
			output?: { trimStart?: number; append?: string } | { set: string };
			details?: JsonValue;
			diagnostics?: readonly ToolDiagnostic[];
	  } & ToolEventCall)
	| ({ type: "tool_execution_end"; entry?: EntryRecord; result?: NestedToolExecutionResult } & ToolEventCall)
	| { type: "inbox_update"; items: readonly QueuedItem[] }
	| { type: "submission"; record: SubmissionRecord }
	| { type: "auto_retry_start"; attempt: number; at: number; errorMessage: string }
	| { type: "auto_retry_end"; attempt: number }
	| { type: "deferred_poll"; pollAt: number }
	| { type: "entry_appended"; entry: EntryRecord }
	| { type: "agent_changed"; agent: AgentState }
	| { type: "usage_changed"; usage: UsageState }
	| { type: "task_failed"; taskId: TaskId; kind: string; message: string }
	| { type: "compaction_start"; taskId: TaskId; reason: CompactionReason; blocking: boolean }
	| { type: "compaction_end"; taskId: TaskId; reason: CompactionReason; error?: string };
export interface AgentEventStream {
	readonly snapshot: SnapshotEvent;
	start(listener: (events: readonly AgentEvent[], context: Context) => Promise<void>): void;
	stop(): Promise<WatchEnd>;
	readonly closed: Promise<WatchEnd>;
}
function parts(view: ConversationView) {
	return {
		live: (view.docs[LiveDoc.definition.kind] ?? {}) as LiveState,
		inbox: view.docs[InboxDoc.definition.kind] as InboxState | undefined,
		agent: view.docs[AgentDoc.definition.kind] as AgentState | undefined,
		usage: view.docs[UsageDoc.definition.kind] as UsageState | undefined,
	};
}
const queued = (inbox: InboxState | undefined): QueuedItem[] =>
	(inbox?.items ?? []).map(({ id, mode }) => ({ id, mode }));
function snapshot(view: ConversationView): SnapshotEvent {
	const { live, inbox, agent, usage } = parts(view);
	return {
		type: "snapshot",
		entries: view.entries,
		...(live.run === undefined ? {} : { run: { inputs: live.run.inputs } }),
		...(live.generation === undefined ? {} : { generation: live.generation as SnapshotEvent["generation"] }),
		tools: live.tools ?? [],
		nestedTools: live.nestedTools ?? [],
		compactions: live.compactions ?? [],
		...(live.compactionFailure === undefined ? {} : { compactionFailure: live.compactionFailure }),
		inbox: queued(inbox),
		agent: agent ?? AgentDoc.definition.initial(),
		usage: usage ?? UsageDoc.definition.initial(),
	};
}
export async function watchEvents(harness: Harness, id: ConversationId, context: Context): Promise<AgentEventStream> {
	const views = conversationViews(harness);
	const { observer } = await views.attach(
		id,
		async (initial, release, storage) => {
			const held = new Set(
				(
					await scanAll((cursor) =>
						storage.scanTasks(
							{ conversationId: id, kind: "axi.generation", status: "completing" },
							100,
							cursor,
							context,
						),
					)
				).map((task) => task.id),
			);
			let current = initial;
			const initialSnapshot = snapshot(initial),
				watch = new Watch<readonly AgentEvent[]>(
					[],
					release,
					(error) => views.report(error),
					() => [snapshot(current)],
				);
			return {
				initialSnapshot,
				watch,
				publication: (
					before: ConversationView,
					after: ConversationView,
					ops: readonly Op[],
					publication: CommitPublication,
					context: Context,
				) => {
					current = after;
					const events = translate(id, before, after, ops, publication, held);
					if (events.length) watch.advance(events, [], context);
				},
				end: (failure: { readonly error: unknown } | undefined) => watch.end(failure),
			};
		},
		context,
	);
	const watch = observer.watch;
	const signal = context.abortSignal;
	if (signal?.aborted) {
		watch.cancel();
		throw signal.reason;
	}
	if (signal !== undefined) watch.observeCancellation(signal);
	return {
		snapshot: observer.initialSnapshot,
		start: (listener) => watch.start((events, _ops, context) => listener(events, context)),
		stop: () => watch.stop(),
		closed: watch.closed,
	};
}
function call(slot: ToolSlot | NestedToolSlot): ToolEventCall {
	return {
		toolCallId: slot.callId,
		toolName: slot.name,
		...(slot.taskId === undefined ? {} : { taskId: slot.taskId }),
		...("parentCallId" in slot ? { parentToolCallId: slot.parentCallId, parentTaskId: slot.parentTaskId } : {}),
	};
}
function resultEntry(entries: readonly EntryRecord[], callId: string): EntryRecord | undefined {
	return entries.find((entry) => entry.model?.[0]?.role === "toolResult" && entry.model[0].toolCallId === callId);
}
function translate(
	id: ConversationId,
	before: ConversationView,
	after: ConversationView,
	ops: readonly Op[],
	publication: CommitPublication,
	held: Set<TaskId>,
): AgentEvent[] {
	const entries: EntryRecord[] = [],
		tasks = new Map<TaskId, TaskRecord<JsonValue, JsonValue, JsonValue>>(),
		submissions: SubmissionRecord[] = [],
		nestedResults = new Map<TaskId, NestedToolExecutionResult>();
	for (const change of publication.changes) {
		if (
			change.type === "document" &&
			change.record.kind === NestedCallDoc.definition.kind &&
			change.value !== null &&
			change.conversationId === id
		) {
			const state = change.value as NestedCallState;
			if (state.taskId !== undefined && state.result !== undefined)
				nestedResults.set(state.taskId, state.result as unknown as NestedToolExecutionResult);
		}
		if (change.type === "entry" && change.value.conversationId === id) entries.push(change.value);
		if (change.type === "task" && change.value.conversationId === id) tasks.set(change.value.id, change.value);
		if (change.type === "submission" && change.value.conversationId === id) submissions.push(change.value);
	}
	if (!ops.length && !entries.length && !tasks.size && !submissions.length) return [];
	submissions.sort((left, right) => left.id - right.id);
	const was = parts(before),
		now = parts(after),
		events: AgentEvent[] = [],
		previousTools = new Map((was.live.tools ?? []).map((slot) => [slot.callId, slot])),
		tools = now.live.tools ?? [],
		previousNested = new Map((was.live.nestedTools ?? []).map((slot) => [slot.taskId, slot])),
		nested = now.live.nestedTools ?? [];
	for (const slot of [...tools, ...nested]) {
		const previous = "parentCallId" in slot ? previousNested.get(slot.taskId) : previousTools.get(slot.callId);
		if (slot.status !== "running" || previous?.status === "running") continue;
		const checkpoint = slot.taskId === undefined ? undefined : tasks.get(slot.taskId)?.state.checkpoint;
		events.push({
			type: "tool_execution_start",
			...call(slot),
			args:
				"parentCallId" in slot
					? slot.arguments
					: ((checkpoint as { arguments?: JsonObject } | undefined)?.arguments ?? {}),
		});
	}
	const oldPartial = was.live.generation?.message as AssistantMessage | undefined,
		partial = now.live.generation?.message as AssistantMessage | undefined;
	if (partial !== undefined) {
		if (oldPartial === undefined) events.push({ type: "message_start", message: partial });
		else if (partial !== oldPartial)
			events.push({ type: "message_update", usage: partial.usage, changes: messageChanges(ops, partial) });
	}
	for (const [at, slot] of tools.entries()) {
		const previous = previousTools.get(slot.callId);
		if (slot.status !== "running" || previous?.status !== "running") continue;
		const update = toolUpdate(ops, ["tools", at], slot, previous);
		if (update) events.push({ type: "tool_execution_update", ...call(slot), ...update });
	}
	for (const [at, slot] of nested.entries()) {
		const previous = previousNested.get(slot.taskId);
		if (slot.status !== "running" || previous?.status !== "running") continue;
		const update = toolUpdate(ops, ["nestedTools", at], slot, previous);
		if (update) events.push({ type: "tool_execution_update", ...call(slot), ...update });
	}
	const generation = now.live.generation,
		oldGeneration = was.live.generation;
	if (generation?.retry !== undefined && oldGeneration?.retry === undefined)
		events.push({
			type: "auto_retry_start",
			attempt: generation.attempt,
			at: generation.retry.at,
			errorMessage: generation.retry.error,
		});
	if (oldGeneration?.retry !== undefined && generation?.retry === undefined)
		events.push({ type: "auto_retry_end", attempt: oldGeneration.attempt });
	if (generation?.deferred !== undefined && generation.deferred.pollAt !== oldGeneration?.deferred?.pollAt)
		events.push({ type: "deferred_poll", pollAt: generation.deferred.pollAt });
	const toolEnds: Extract<AgentEvent, { type: "tool_execution_end" }>[] = [];
	const endTool = (slot: ToolSlot, entryId: number | undefined) => {
		const entry = entries.find((entry) => entry.id === entryId);
		toolEnds.push({ type: "tool_execution_end", ...call(slot), ...(entry === undefined ? {} : { entry }) });
	};
	for (const previous of previousTools.values()) {
		if (previous.status === "done") continue;
		const slot = tools.find((slot) => slot.callId === previous.callId);
		if (slot?.status === "done") endTool(slot, slot.entry);
		else if (slot === undefined) endTool(previous, resultEntry(entries, previous.callId)?.id);
	}
	for (const slot of tools) if (slot.status === "done" && !previousTools.has(slot.callId)) endTool(slot, slot.entry);
	const endNested = (slot: NestedToolSlot) => {
		const result = nestedResults.get(slot.taskId);
		events.push({ type: "tool_execution_end", ...call(slot), ...(result === undefined ? {} : { result }) });
	};
	const activeNested = new Map(nested.map((slot) => [slot.taskId, slot]));
	for (const previous of [...previousNested.values()].reverse()) {
		if (previous.status === "done") continue;
		const slot = activeNested.get(previous.taskId);
		if (slot === undefined || slot.status === "done") endNested(slot ?? previous);
	}
	for (const slot of [...nested].reverse())
		if (slot.status === "done" && !previousNested.has(slot.taskId)) endNested(slot);
	let assistantAppended = false;
	for (const entry of entries) {
		events.push(...toolEnds.filter((event) => event.entry === entry));
		const message = entry.model?.[0];
		if (message === undefined) {
			events.push({ type: "entry_appended", entry });
			continue;
		}
		const streamed = message.role === "assistant" && oldPartial !== undefined && !assistantAppended;
		if (message.role === "assistant") assistantAppended = true;
		if (!streamed) events.push({ type: "message_start", message });
		events.push({ type: "message_end", entry });
	}
	events.push(...toolEnds.filter((event) => event.entry === undefined));
	const previousCompactions = was.live.compactions ?? [],
		compactions = now.live.compactions ?? [],
		failure = now.live.compactionFailure;
	for (const { taskId, reason } of previousCompactions)
		if (!compactions.some((status) => status.taskId === taskId))
			events.push({
				type: "compaction_end",
				taskId,
				reason,
				...(failure?.taskId === taskId ? { error: failure.error } : {}),
			});
	let turnEnded = false;
	for (const task of tasks.values()) {
		if (task.kind === "axi.generation" && task.state.status === "completing" && !held.has(task.id)) {
			held.add(task.id);
			turnEnded = true;
		}
		if (task.state.status !== "terminal") continue;
		if (task.kind === "axi.generation" && !held.delete(task.id)) turnEnded = true;
		const outcome = task.state.outcome;
		if (outcome.status === "faulted" || outcome.status === "orphaned")
			events.push({
				type: "task_failed",
				taskId: task.id,
				kind: task.kind,
				message: outcome.status === "faulted" ? outcome.error.message : outcome.reason,
			});
	}
	if (turnEnded) events.push({ type: "turn_end" });
	const run = now.live.run,
		previousRun = was.live.run,
		runChanged = run?.inputs[0] !== previousRun?.inputs[0];
	if (previousRun !== undefined && runChanged) events.push({ type: "run_end", inputs: previousRun.inputs });
	for (const record of submissions) events.push({ type: "submission", record });
	if (now.inbox !== was.inbox) events.push({ type: "inbox_update", items: queued(now.inbox) });
	if (now.agent !== was.agent)
		events.push({ type: "agent_changed", agent: now.agent ?? AgentDoc.definition.initial() });
	if (now.usage !== was.usage)
		events.push({ type: "usage_changed", usage: now.usage ?? UsageDoc.definition.initial() });
	for (const { taskId, reason, blocking } of compactions)
		if (!previousCompactions.some((status) => status.taskId === taskId))
			events.push({ type: "compaction_start", taskId, reason, blocking });
	if (run !== undefined && runChanged) events.push({ type: "run_start", inputs: run.inputs });
	if (run !== undefined && run.taskId !== previousRun?.taskId && tasks.get(run.taskId)?.kind === "axi.generation")
		events.push({ type: "turn_start" });
	return events;
}
const partialPath = ["docs", LiveDoc.definition.kind, "generation", "message"];
const starts = (path: Path, prefix: readonly (string | number)[]) =>
	prefix.length <= path.length && prefix.every((part, index) => path[index] === part);
function messageChanges(ops: readonly Op[], message: AssistantMessage): MessageChange[] {
	const changes: MessageChange[] = [],
		whole = new Set<number>();
	for (const op of ops) {
		const path = op[1] as Path;
		if (!starts(path, partialPath)) {
			if (starts(partialPath, path)) return [{ type: "message", message }];
			continue;
		}
		const rest = path.slice(partialPath.length);
		if (rest[0] === "usage") continue;
		if (rest[0] !== "content") return [{ type: "message", message }];
		if (rest.length === 1) {
			if (op[0] !== "p" || op[3] !== 0) return [{ type: "message", message }];
			for (const [offset, block] of (op[4] as unknown as Block[]).entries())
				changes.push({
					type: block.type === "text" ? "text_start" : block.type === "thinking" ? "thinking_start" : "toolcall_start",
					contentIndex: op[2] + offset,
					block,
				});
			continue;
		}
		const contentIndex = rest[1] as number,
			field = rest[2];
		if (whole.has(contentIndex)) continue;
		if (op[0] === "a" && rest.length === 3 && (field === "text" || field === "thinking"))
			changes.push({ type: field === "text" ? "text_delta" : "thinking_delta", contentIndex, delta: op[2] });
		else if (op[0] === "a" && field === "arguments")
			changes.push({ type: "toolcall_delta", contentIndex, path: rest.slice(3), delta: op[2] });
		else {
			whole.add(contentIndex);
			changes.push({ type: "block", contentIndex, block: message.content[contentIndex]! });
		}
	}
	return changes;
}
function toolUpdate(
	ops: readonly Op[],
	at: readonly ["tools" | "nestedTools", number],
	slot: ToolSlot | NestedToolSlot,
	previous: ToolSlot | NestedToolSlot,
): Omit<Extract<AgentEvent, { type: "tool_execution_update" }>, "type" | keyof ToolEventCall> | undefined {
	const path = ["docs", LiveDoc.definition.kind, ...at, "output"];
	let trimStart = 0,
		append = "",
		replaced = false;
	for (const op of ops) {
		if (!starts(op[1] as Path, path)) continue;
		if (op[0] === "t") trimStart += op[2];
		else if (op[0] === "a") append += op[2];
		else replaced = true;
	}
	let output: { trimStart?: number; append?: string } | { set: string } | undefined;
	if (replaced || (slot.output !== previous.output && trimStart === 0 && append === ""))
		output = { set: slot.output ?? "" };
	else if (trimStart > 0 || append !== "")
		output = { ...(trimStart > 0 ? { trimStart } : {}), ...(append === "" ? {} : { append }) };
	const update = {
		...(output === undefined ? {} : { output }),
		...(slot.details === previous.details ? {} : { details: slot.details ?? null }),
		...(slot.diagnostics === previous.diagnostics ? {} : { diagnostics: slot.diagnostics ?? [] }),
	};
	return Object.keys(update).length ? update : undefined;
}
