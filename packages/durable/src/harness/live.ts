import { copyJson, type Draft, type JsonRepresentation, type JsonValue } from "@axi/chord";
import type { AssistantMessage, Usage } from "@axi/ai";
import { defineDoc } from "../documents.ts";
import { AssistantEntry } from "../entries.ts";
import type { Transaction } from "../session/transaction.ts";
import type {
	ConversationId,
	EntryId,
	JsonObject,
	SubmissionId,
	SubmissionSettlement,
	TaskId,
	TaskOutcome,
	TaskRecord,
	Tx,
	TypedEntry,
} from "../types.ts";
import type { CompactionReason, CompactionResult, ToolDiagnostic } from "./types.ts";
import { recordUsage } from "./usage.ts";

type SlotProgress = {
	callId: string;
	name: string;
	status: "pending" | "running" | "done";
	output?: string;
	droppedBytes?: number;
	droppedLines?: number;
	details?: JsonValue;
	diagnostics?: ToolDiagnostic[];
};
export type ToolSlot = SlotProgress & { taskId?: TaskId; entry?: EntryId };
export type NestedToolSummary = {
	isError: boolean;
	durationMs?: number;
	usage?: JsonRepresentation<Usage>;
	error?: string;
};
export type NestedToolSlot = SlotProgress & {
	parentCallId: string;
	parentTaskId: TaskId;
	taskId: TaskId;
	arguments: JsonObject;
	summary?: NestedToolSummary;
};
export type CompactionStatus = {
	taskId: TaskId<CompactionResult>;
	reason: CompactionReason;
	blocking: boolean;
	attempt: number;
	retry?: { at: number; error: string };
};
export type CompactionFailure = { taskId: TaskId<CompactionResult>; reason: CompactionReason; error: string };
export type LiveState = {
	run?: { taskId: TaskId; inputs: SubmissionId[] };
	generation?: {
		attempt: number;
		message?: JsonRepresentation<AssistantMessage>;
		retry?: { at: number; error: string };
		deferred?: { pollAt: number };
	};
	tools?: ToolSlot[];
	nestedTools?: NestedToolSlot[];
	compactions?: CompactionStatus[];
	compactionFailure?: CompactionFailure;
};
export const LiveDoc = defineDoc<LiveState>({
	kind: "axi.live",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({}),
	checkpointWhen: (state) =>
		state.generation === undefined &&
		!state.tools?.some((slot) => slot.status === "running") &&
		!state.nestedTools?.some((slot) => slot.status === "running"),
});
export function endRun(tx: Tx, live: Draft<LiveState>, taskId: TaskId, settlement: SubmissionSettlement): void {
	if (live.run?.taskId === taskId) {
		for (const input of live.run.inputs) tx.settleSubmission(input, settlement);
		delete live.run;
	}
	delete live.generation;
	delete live.tools;
	delete live.nestedTools;
}
export function addCompactionStatus(live: Draft<LiveState>, status: CompactionStatus): void {
	live.compactions ??= [];
	live.compactions.push(status);
}
export function compactionStatus(live: Draft<LiveState>, id: TaskId): Draft<CompactionStatus> | undefined {
	return live.compactions?.find((status) => status.taskId === id);
}
export function removeCompactionStatus(live: Draft<LiveState>, id: TaskId): void {
	const statuses = live.compactions;
	if (!statuses) return;
	const index = statuses.findIndex((status) => status.taskId === id);
	if (index >= 0) statuses.splice(index, 1);
	if (!statuses.length) delete live.compactions;
}
export function failCompactionStatus(live: Draft<LiveState>, id: TaskId, error: string): void {
	const status = compactionStatus(live, id);
	if (status) live.compactionFailure = { taskId: status.taskId, reason: status.reason, error };
	removeCompactionStatus(live, id);
}
export function toolSlot(live: Draft<LiveState>, id: TaskId): Draft<ToolSlot | NestedToolSlot> | undefined {
	const direct = live.tools?.find((slot) => slot.taskId === id);
	if (direct || !live.nestedTools) return direct;
	const slots = live.nestedTools;
	let from = 0,
		to = slots.length;
	while (from < to) {
		const middle = Math.floor((from + to) / 2);
		if (slots[middle]!.taskId < id) from = middle + 1;
		else to = middle;
	}
	return slots[from]?.taskId === id ? slots[from] : undefined;
}
export function clearProgress(slot: Draft<SlotProgress>): void {
	for (const key of ["output", "droppedBytes", "droppedLines", "details", "diagnostics"] as const) delete slot[key];
}
export function finishSlot(slot: Draft<ToolSlot | NestedToolSlot>): void {
	slot.status = "done";
	clearProgress(slot);
}
export function removeNestedSlots(live: Draft<LiveState>, id: TaskId): void {
	const slots = live.nestedTools;
	if (!slots) return;
	const removed = new Set<TaskId>([id]);
	for (const slot of slots) if (removed.has(slot.parentTaskId)) removed.add(slot.taskId);
	for (let index = slots.length - 1; index >= 0; index--)
		if (removed.has(slots[index]!.parentTaskId)) slots.splice(index, 1);
	if (!slots.length) delete live.nestedTools;
}
export async function appendAssistant(
	tx: Tx,
	id: ConversationId,
	message: AssistantMessage,
): Promise<TypedEntry<never>> {
	await recordUsage(tx, id, "models", `${message.provider}/${message.model}`, message.usage);
	return tx.appendEntry(AssistantEntry, id, { model: [message] });
}
export async function convertPartial(tx: Tx, live: Draft<LiveState>, id: ConversationId): Promise<void> {
	const partial = live.generation?.message;
	if (partial !== undefined) {
		const message = copyJson(partial) as unknown as AssistantMessage;
		await appendAssistant(tx, id, { ...message, stopReason: "aborted" });
	}
}
export async function settleSchedulerOutcome(
	tx: Transaction,
	record: TaskRecord<JsonValue, JsonValue, JsonValue>,
	outcome: Extract<TaskOutcome<JsonValue>, { readonly status: "faulted" | "orphaned" }>,
): Promise<void> {
	if (record.kind === "axi.tool") {
		const live = await tx.doc(LiveDoc, record.conversationId);
		const slot = toolSlot(live, record.id);
		if (slot) finishSlot(slot);
		removeNestedSlots(live, record.id);
	} else if (record.kind === "axi.compaction") {
		failCompactionStatus(
			await tx.doc(LiveDoc, record.conversationId),
			record.id,
			outcome.status === "faulted" ? outcome.error.message : outcome.reason,
		);
	} else if (record.kind === "axi.generation") {
		const live = await tx.doc(LiveDoc, record.conversationId);
		if (live.run?.taskId !== record.id) return;
		await convertPartial(tx, live, record.conversationId);
		endRun(
			tx,
			live,
			record.id,
			outcome.status === "faulted"
				? { status: "unanswered", reason: "faulted", detail: outcome.error.message }
				: { status: "unanswered", reason: outcome.reason },
		);
	}
}
