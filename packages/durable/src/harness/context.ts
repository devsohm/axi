import type { Context } from "@axi/chord";
import type { Message, ToolCall, ToolResultMessage } from "@axi/ai";
import { SystemEntry } from "../entries.ts";
import { idFromNumber } from "../ids.ts";
import type { SessionImpl } from "../session/session.ts";
import type { ContextEdit, ConversationId, Cursor, EntryId, EntryQuery, EntryRecord, Storage } from "../types.ts";
import type { ContextView } from "./types.ts";

export type ContextBounds = {
	readonly head: (EntryRecord & { readonly head: EntryId }) | undefined;
	readonly tail: EntryId;
};
export type ContextRange = {
	readonly bounds: ContextBounds;
	readonly entries: readonly EntryRecord[];
	readonly view: ContextView;
	readonly edited: ReadonlySet<EntryId>;
	readonly settled: readonly Message[];
	readonly open: readonly Message[];
	readonly baseline: Message | null | undefined;
};
const frozen = new WeakSet<object>();
function freeze<T>(value: T): T {
	if (value !== null && typeof value === "object" && !frozen.has(value)) {
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
		frozen.add(value);
	}
	return value;
}
const empty = (): ContextView => ({ head: undefined, entries: [], contributions: [], messages: [] });

export async function captureContextBounds(
	storage: Storage,
	id: ConversationId,
	context: Context,
	at?: EntryId,
): Promise<ContextBounds | undefined> {
	let tail = at;
	if (at === undefined) tail = (await storage.scanEntries({ conversationId: id }, 1, undefined, context)).items[0]?.id;
	else if ((await storage.entry(id, at, context)) === undefined)
		throw new Error(`Entry ${at} is not visible from conversation ${id}`);
	return tail === undefined ? undefined : { tail, head: await storage.findLatestHeadMarker(id, tail, context) };
}
async function scan(
	storage: Storage,
	id: ConversationId,
	query: Omit<EntryQuery, "conversationId">,
	context: Context,
): Promise<EntryRecord[]> {
	const items: EntryRecord[] = [];
	let cursor: Cursor | undefined;
	do {
		const page = await storage.scanEntries({ ...query, conversationId: id }, 256, cursor, context);
		items.push(...page.items);
		cursor = page.next;
	} while (cursor !== undefined);
	return items.reverse();
}
function query(bounds: ContextBounds): Omit<EntryQuery, "conversationId"> {
	return { ...(bounds.head === undefined ? {} : { minEntryId: bounds.head.head }), maxEntryId: bounds.tail };
}
function select(bounds: ContextBounds, items: readonly EntryRecord[]): readonly EntryRecord[] {
	return bounds.head ? [bounds.head, ...items.filter((item) => item.head === undefined)] : items;
}
export async function activeEntries(
	storage: Storage,
	id: ConversationId,
	bounds: ContextBounds | undefined,
	context: Context,
): Promise<readonly EntryRecord[]> {
	return bounds === undefined ? [] : select(bounds, await scan(storage, id, query(bounds), context));
}
function contribution(entry: EntryRecord, edit: ContextEdit | undefined): readonly Message[] {
	const messages = edit?.action === "omit" ? [] : edit?.action === "replace" ? edit.messages : (entry.model ?? []);
	return Object.freeze(
		messages.filter(
			(message) =>
				message.role !== "assistant" ||
				(message.stopReason !== "aborted" && message.stopReason !== "error" && message.stopReason !== "deferred"),
		),
	);
}
function baseline(head: ContextBounds["head"], items: readonly EntryRecord[]): Message | null | undefined {
	for (const item of items) {
		if (head && item.id <= head.id) continue;
		if (SystemEntry.is(item)) return item.model?.find((message) => message.role === "system") ?? null;
		if (
			head === undefined &&
			(item.model?.some((message) => message.role === "system") ||
				item.edits?.some(
					(edit) => edit.action === "replace" && edit.messages.some((message) => message.role === "system"),
				))
		)
			return null;
	}
	return undefined;
}
function leading(messages: Message[], base: Message | null | undefined): Message[] {
	const index = messages.findIndex((message) => message.role === "system");
	if (index <= 0 || (messages[index] !== base && messages.slice(0, index).some((message) => message.role !== "user")))
		return messages;
	return [messages[index]!, ...messages.slice(0, index), ...messages.slice(index + 1)];
}
function settled(
	before: readonly Message[],
	pending: readonly Message[],
): { settled: readonly Message[]; open: readonly Message[] } {
	const last = pending.findLastIndex((message) => message.role === "assistant");
	return last <= 0
		? { settled: before, open: pending }
		: {
				settled: [...before, ...orderToolResults(pending.slice(0, last))],
				open: pending.slice(last),
			};
}
function derive(bounds: ContextBounds, entries: readonly EntryRecord[]): ContextRange {
	const edits = new Map<EntryId, ContextEdit>();
	for (const entry of entries) for (const edit of entry.edits ?? []) edits.set(edit.target, edit);
	const active = select(bounds, entries);
	const contributions = active.map((entry) => contribution(entry, edits.get(entry.id)));
	const parts = settled([], contributions.flat());
	const base = baseline(bounds.head, active);
	return {
		bounds,
		entries,
		edited: new Set(edits.keys()),
		...parts,
		baseline: base,
		view: {
			head: bounds.head,
			entries: active,
			contributions,
			messages: leading([...parts.settled, ...orderToolResults(parts.open)], base),
		},
	};
}
function extend(previous: ContextRange, bounds: ContextBounds, added: readonly EntryRecord[]): ContextRange {
	const entries = [...previous.entries, ...added];
	if (added.some((item) => item.edits !== undefined || item.head !== undefined || previous.edited.has(item.id)))
		return derive(bounds, entries);
	const contributions = added.map((item) => contribution(item, undefined));
	const parts = settled(previous.settled, [...previous.open, ...contributions.flat()]);
	const base = previous.baseline === undefined ? baseline(bounds.head, added) : previous.baseline;
	return {
		bounds,
		entries,
		edited: previous.edited,
		...parts,
		baseline: base,
		view: {
			head: bounds.head,
			entries: [...previous.view.entries, ...added],
			contributions: [...previous.view.contributions, ...contributions],
			messages: leading([...parts.settled, ...orderToolResults(parts.open)], base),
		},
	};
}
export async function deriveContext(
	storage: Storage,
	id: ConversationId,
	bounds: ContextBounds | undefined,
	context: Context,
): Promise<ContextView> {
	return bounds === undefined ? empty() : derive(bounds, await scan(storage, id, query(bounds), context)).view;
}
export async function readContext(
	session: SessionImpl,
	storage: Storage,
	id: ConversationId,
	context: Context,
	at?: EntryId,
): Promise<ContextView> {
	return deriveContext(
		storage,
		id,
		await session.readOnLine(() => captureContextBounds(storage, id, context, at)),
		context,
	);
}
export async function readContextFrom(
	session: SessionImpl,
	storage: Storage,
	id: ConversationId,
	context: Context,
	at: EntryId | undefined,
	previous: ContextRange | undefined,
): Promise<{ readonly view: ContextView; readonly range: ContextRange | undefined }> {
	const bounds = await session.readOnLine(() => captureContextBounds(storage, id, context, at));
	if (bounds === undefined) return { view: empty(), range: undefined };
	freeze(bounds.head);
	let range: ContextRange;
	if (!previous || previous.bounds.head?.id !== bounds.head?.id)
		range = derive(bounds, freeze(await scan(storage, id, query(bounds), context)));
	else if (bounds.tail === previous.bounds.tail) range = previous;
	else if (bounds.tail < previous.bounds.tail)
		range = derive(
			bounds,
			previous.entries.filter((item) => item.id <= bounds.tail),
		);
	else
		range = extend(
			previous,
			bounds,
			freeze(
				await scan(
					storage,
					id,
					{
						minEntryId: idFromNumber<EntryId>(previous.bounds.tail + 1),
						maxEntryId: bounds.tail,
					},
					context,
				),
			),
		);
	return {
		range,
		view: {
			...range.view,
			entries: [...range.view.entries],
			contributions: [...range.view.contributions],
			messages: [...range.view.messages],
		},
	};
}

export function orderToolResults(messages: readonly Message[]): Message[] {
	const result: Message[] = [];
	for (let position = 0; position < messages.length; position++) {
		const message = messages[position]!;
		if (message.role === "toolResult") continue;
		result.push(message);
		if (message.role !== "assistant") continue;
		const calls = message.content.filter((content): content is ToolCall => content.type === "toolCall");
		if (!calls.length) continue;
		const replies = new Map<string, ToolResultMessage>();
		for (let next = position + 1; next < messages.length; next++) {
			const reply = messages[next]!;
			if (reply.role === "assistant") break;
			if (reply.role === "toolResult" && !replies.has(reply.toolCallId)) replies.set(reply.toolCallId, reply);
		}
		for (const call of calls)
			result.push(
				replies.get(call.id) ??
					freeze({
						role: "toolResult",
						toolCallId: call.id,
						toolName: call.name,
						content: [{ type: "text", text: "Tool result unavailable: history ends before this call completed." }],
						isError: true,
						details: { reason: "missing_result" },
						timestamp: message.timestamp,
					}),
			);
	}
	return result;
}
