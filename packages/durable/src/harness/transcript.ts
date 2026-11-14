import type { Context } from "@axi/objects/context";
import { idFromNumber } from "../ids.ts";
import type { Cursor, EntryId, EntryQuery, EntryRecord, Page } from "../types.ts";
import type { ConversationView, ConversationWindow } from "./view.ts";

export type TranscriptItem =
	| { readonly kind: "entry"; readonly entry: EntryRecord }
	| { readonly kind: "gap"; readonly after: EntryId; readonly upTo: EntryId }
	| { readonly kind: "earlier" };
export type TranscriptView = Omit<ConversationView, "entries" | "before"> & {
	readonly items: readonly TranscriptItem[];
};
export type EntryLoader = (
	query: Omit<EntryQuery, "conversationId">,
	limit: number,
	context: Context,
) => Promise<Page<EntryRecord, Cursor>>;
export type ConversationTranscriptOptions = { readonly pageSize?: number };
type Gap = Extract<TranscriptItem, { kind: "gap" }>;
type Row = Extract<TranscriptItem, { kind: "entry" }>;
const EARLIER: TranscriptItem = Object.freeze({ kind: "earlier" });

export class ConversationTranscript {
	readonly #loader: EntryLoader;
	readonly #pageSize: number;
	readonly #ids = new Set<EntryId>();
	readonly #loading = new Map<string, Promise<TranscriptView>>();
	#bounds: { after: number; through: number } | undefined;
	#gaps: Gap[] = [];
	#rows: Row[] = [];
	#items: readonly TranscriptItem[] = [];
	#last: ConversationView | undefined;
	#view: TranscriptView | undefined;
	constructor(load: EntryLoader, options?: ConversationTranscriptOptions) {
		this.#pageSize = options?.pageSize ?? 50;
		if (!Number.isSafeInteger(this.#pageSize) || this.#pageSize < 1)
			throw new RangeError(`Page size must be an integer >= 1, got ${this.#pageSize}`);
		this.#loader = load;
	}
	get newest(): EntryId | undefined {
		const tail = this.#bounds?.through;
		return tail === undefined || tail === -Infinity ? undefined : idFromNumber<EntryId>(tail);
	}
	get resume(): ConversationWindow | undefined {
		if (this.#last === undefined) return undefined;
		return this.newest === undefined ? {} : { from: idFromNumber<EntryId>(this.newest + 1) };
	}
	merge(view: ConversationView): TranscriptView {
		this.#last = view;
		const through = view.entries.at(-1)?.id ?? view.before ?? -Infinity;
		this.#cover(view.before ?? -Infinity, through, view.entries);
		return this.#result();
	}
	loadEarlier(context: Context): Promise<TranscriptView> {
		if (this.#last === undefined) return Promise.reject(new Error("ConversationTranscript: merge a view first"));
		const low = this.#bounds!.after;
		if (low === -Infinity) return Promise.resolve(this.#result());
		return this.#once("earlier", async () => {
			const page = await this.#loader(
				{ maxEntryId: idFromNumber<EntryId>(low), order: "descending" },
				this.#pageSize,
				context,
			);
			const entries = [...page.items].reverse();
			const from = page.next === undefined || entries.length === 0 ? -Infinity : entries[0]!.id - 1;
			this.#cover(from, low, entries);
			return this.#result();
		});
	}
	fillGap(gap: Gap, context: Context): Promise<TranscriptView> {
		if (this.#last === undefined) return Promise.reject(new Error("ConversationTranscript: merge a view first"));
		const current = this.#items.find(
			(item): item is Gap => item.kind === "gap" && item.after < gap.upTo && gap.after < item.upTo,
		);
		if (current === undefined) return Promise.resolve(this.#result());
		return this.#once(`gap:${current.after}:${current.upTo}`, async () => {
			const page = await this.#loader(
				{
					minEntryId: idFromNumber<EntryId>(current.after + 1),
					maxEntryId: idFromNumber<EntryId>(current.upTo - 1),
					order: "ascending",
				},
				this.#pageSize,
				context,
			);
			const through = page.next === undefined || page.items.length === 0 ? current.upTo - 1 : page.items.at(-1)!.id;
			this.#cover(current.after, through, page.items);
			return this.#result();
		});
	}
	#once(key: string, load: () => Promise<TranscriptView>): Promise<TranscriptView> {
		const current = this.#loading.get(key);
		if (current !== undefined) return current;
		const pending = Promise.resolve().then(load);
		this.#loading.set(key, pending);
		const release = () => {
			if (this.#loading.get(key) === pending) this.#loading.delete(key);
		};
		pending.then(release, release);
		return pending;
	}
	#cover(after: number, through: number, entries: readonly EntryRecord[]): void {
		const fresh: Row[] = [];
		for (const entry of entries)
			if (!this.#ids.has(entry.id)) {
				this.#ids.add(entry.id);
				fresh.push({ kind: "entry", entry });
			}
		const previous = this.#bounds;
		const noHistory = this.#rows.length === 0 && this.#gaps.length === 0;
		this.#rows = mergeRows(this.#rows, fresh);
		if (previous === undefined || (noHistory && after >= previous.through)) {
			this.#bounds = { after, through: Math.max(previous?.through ?? -Infinity, through) };
		} else if (after > previous.through) {
			this.#gaps.push(gapOf(previous.through, entries[0]?.id ?? after + 1));
			this.#bounds = { after: previous.after, through };
		} else if (through !== -Infinity && through < previous.after) {
			const next = this.#rows.find((row) => row.entry.id > through)?.entry.id ?? previous.after + 1;
			this.#gaps.unshift(gapOf(through, next));
			this.#bounds = { after, through: previous.through };
		} else {
			if (through > after) {
				const remaining: Gap[] = [];
				for (const gap of this.#gaps) {
					if (through <= gap.after || after + 1 >= gap.upTo) {
						remaining.push(gap);
						continue;
					}
					if (after > gap.after) {
						const next = this.#rows.find((row) => row.entry.id > after)?.entry.id ?? after + 1;
						remaining.push(gapOf(gap.after, Math.min(gap.upTo, next)));
					}
					if (through + 1 < gap.upTo) remaining.push(gapOf(through, gap.upTo));
				}
				this.#gaps = remaining;
			}
			this.#bounds = { after: Math.min(after, previous.after), through: Math.max(through, previous.through) };
		}
		const gaps = this.#gaps;
		const items: TranscriptItem[] = this.#bounds.after === -Infinity ? [] : [EARLIER];
		let next = 0;
		for (const row of this.#rows) {
			while (next < gaps.length && gaps[next]!.after < row.entry.id) items.push(gaps[next++]!);
			items.push(row);
		}
		items.push(...gaps.slice(next));
		if (items.length !== this.#items.length || items.some((item, index) => !sameItem(item, this.#items[index]!)))
			this.#items = items;
	}
	#result(): TranscriptView {
		const last = this.#last!;
		if (
			this.#view?.items === this.#items &&
			this.#view.docs === last.docs &&
			this.#view.conversation === last.conversation
		)
			return this.#view;
		this.#view = { conversation: last.conversation, docs: last.docs, items: this.#items };
		return this.#view;
	}
}
function sameItem(left: TranscriptItem, right: TranscriptItem): boolean {
	if (left === right) return true;
	return left.kind === "gap" && right.kind === "gap" && left.after === right.after && left.upTo === right.upTo;
}
function mergeRows(held: Row[], added: Row[]): Row[] {
	if (added.length === 0) return held;
	const result: Row[] = [];
	let next = 0;
	for (const row of held) {
		while (next < added.length && added[next]!.entry.id < row.entry.id) result.push(added[next++]!);
		result.push(row);
	}
	result.push(...added.slice(next));
	return result;
}

function gapOf(after: number, upTo: number): Gap {
	return Object.freeze({ kind: "gap", after: idFromNumber<EntryId>(after), upTo: idFromNumber<EntryId>(upTo) });
}
