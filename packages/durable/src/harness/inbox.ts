import { copyJson, type Draft, type JsonRepresentation } from "@axi/chord";
import { defineDoc } from "../documents.ts";
import { UserEntry } from "../entries.ts";
import type { ConversationId, EntryDraft, EntryId, EntryRecord, JsonObject, SubmissionId, Tx } from "../types.ts";
import type { InputEntry, QueueMode, Settings, UserInput } from "./types.ts";

export type InboxItem =
	| {
			id: SubmissionId;
			mode: "steer" | "followUp";
			content: JsonRepresentation<UserInput>;
			entry?: JsonRepresentation<InputEntry>;
	  }
	| { id: SubmissionId; mode: "write"; entry: JsonObject };
export type InboxState = { items: InboxItem[] };
export const InboxDoc = defineDoc<InboxState>({
	kind: "axi.inbox",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ items: [] }),
	checkpointWhen: (state) => state.items.length === 0,
});
export type QueueModes = Pick<Settings, "steeringMode" | "followUpMode">;
export type Boundary = {
	readonly conversationId: ConversationId;
	readonly inbox: Draft<InboxState>;
	readonly steeringMode: QueueMode;
	readonly followUpMode: QueueMode;
	head: EntryId | undefined;
};
export type BoundaryResult = { readonly users: SubmissionId[]; readonly reset: boolean };

export async function prepareBoundary(tx: Tx, conversationId: ConversationId, modes: QueueModes): Promise<Boundary> {
	const head = (await tx.latestHeadMarker(conversationId))?.head;
	return {
		conversationId,
		head,
		inbox: await tx.doc(InboxDoc, conversationId),
		steeringMode: modes.steeringMode,
		followUpMode: modes.followUpMode,
	};
}
export async function applyBoundary(
	tx: Tx,
	boundary: Boundary,
	at: "postTools" | "final",
	now: number,
): Promise<BoundaryResult> {
	const { inbox, conversationId } = boundary;
	const reset = hasQueuedReset(inbox.items);
	const writes: number[] = [],
		users: number[] = [];
	let steers = 0,
		followUps = 0;
	for (let index = 0; index < inbox.items.length; index++) {
		const mode = inbox.items[index]!.mode;
		if (mode === "write") writes.push(index);
		else if (mode === "steer") {
			if (boundary.steeringMode === "all" || steers++ === 0) users.push(index);
		} else if (at === "final" || reset) {
			if (boundary.followUpMode === "all" || followUps++ === 0) users.push(index);
		}
	}
	for (const index of writes) {
		const item = inbox.items[index]!;
		if (item.mode !== "write") continue;
		const draft = item.entry as unknown as EntryDraft;
		if (isStale(boundary, draft)) tx.settleSubmission(item.id, { status: "unanswered", reason: "stale" });
		else {
			const entry = await tx.appendEntry(conversationId, draft);
			if (draft.head !== undefined) boundary.head = draft.head === "self" ? entry.id : draft.head;
			tx.placeSubmission(item.id, entry.id);
		}
	}
	const placed: SubmissionId[] = [];
	for (const index of users) {
		const item = inbox.items[index]!;
		if (item.mode === "write") continue;
		const entry = await appendInput(
			tx,
			conversationId,
			item.content as UserInput,
			item.entry as InputEntry | undefined,
			now,
		);
		tx.placeSubmission(item.id, entry.id);
		placed.push(item.id);
	}
	for (const index of [...writes, ...users].sort((a, b) => b - a)) inbox.items.splice(index, 1);
	return { users: placed, reset };
}
export function appendInput(
	tx: Tx,
	id: ConversationId,
	content: UserInput,
	entry: InputEntry | undefined,
	now: number,
): Promise<EntryRecord> {
	const model = [{ role: "user", content, timestamp: now } as const];
	return entry === undefined
		? tx.appendEntry(UserEntry, id, { model })
		: tx.appendEntry(id, { ...pickInputEntry(entry), model });
}
export function pickInputEntry({ kind, data }: InputEntry): JsonRepresentation<InputEntry> {
	return copyJson(
		{ kind, ...(data === undefined ? {} : { data }) },
		{ omitUndefinedProperties: true },
	) as JsonRepresentation<InputEntry>;
}
export function isDisplayOnly(entry: EntryDraft): boolean {
	return entry.model === undefined && entry.head === undefined && entry.edits === undefined;
}
export function hasQueuedReset(items: readonly InboxItem[]): boolean {
	return items.some((item) => item.mode === "write" && item.entry.head === "self");
}
export function isStale(boundary: Boundary, entry: EntryDraft): boolean {
	return typeof entry.head === "number" && boundary.head !== undefined && entry.head < boundary.head;
}
export async function removeInboxItem(tx: Tx, id: ConversationId, submission: SubmissionId): Promise<void> {
	const items = (await tx.doc(InboxDoc, id)).items;
	const index = items.findIndex((item) => item.id === submission);
	if (index >= 0) items.splice(index, 1);
}
export async function withdrawQueuedInputs(tx: Tx, id: ConversationId, reason = "aborted"): Promise<void> {
	const items = (await tx.doc(InboxDoc, id)).items;
	for (let index = items.length - 1; index >= 0; index--) {
		const item = items[index]!;
		if (item.mode !== "write") {
			tx.settleSubmission(item.id, { status: "unanswered", reason });
			items.splice(index, 1);
		}
	}
}
