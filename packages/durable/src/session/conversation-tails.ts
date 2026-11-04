import type * as T from "../types.ts";
import { freezeRecord, LruMap } from "./record-cache.ts";
export type HeadMarker = T.EntryRecord & { readonly head: T.EntryId };
const hasHead = (entry: T.EntryRecord): entry is HeadMarker => entry.head !== undefined;

export class ConversationTails {
	readonly #latest = new LruMap<T.ConversationId, T.EntryId | null>(4096);
	readonly #heads = new LruMap<T.ConversationId, HeadMarker | null>(256);
	async latest(id: T.ConversationId, read: () => Promise<T.EntryId | undefined>): Promise<T.EntryId | undefined> {
		const known = this.#latest.get(id);
		if (known !== undefined) return known ?? undefined;
		const value = await read();
		this.#latest.set(id, value ?? null);
		return value;
	}
	async marker(
		id: T.ConversationId,
		before: T.EntryId | undefined,
		read: () => Promise<HeadMarker | undefined>,
	): Promise<HeadMarker | undefined> {
		const known = this.#heads.get(id);
		if (known === null) return undefined;
		if (known !== undefined && (before === undefined || before >= known.id)) return known;
		const latest = this.#latest.peek(id);
		const value = await read();
		if (before === undefined || (latest !== undefined && before >= (latest ?? 0)))
			this.#heads.set(id, value === undefined ? null : freezeRecord(value));
		return value;
	}
	peek(id: T.ConversationId): T.EntryId | null | undefined {
		return this.#latest.peek(id);
	}
	apply(writes: readonly T.StorageWrite[]): void {
		for (const write of writes) {
			if (write.type === "conversation" && write.value.parent === undefined) {
				this.#latest.set(write.value.id, null);
				this.#heads.set(write.value.id, null);
			} else if (write.type === "entry") {
				this.#latest.set(write.value.conversationId, write.value.id);
				if (hasHead(write.value)) this.#heads.set(write.value.conversationId, freezeRecord(write.value));
			}
		}
	}
	get size(): number {
		return this.#latest.size;
	}
	get markers(): number {
		return this.#heads.size;
	}
}
