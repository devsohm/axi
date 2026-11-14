import type { Context } from "../context/index.ts";
import { ObjectsError } from "../data/index.ts";
import { invalid } from "../data/internal.ts";
import { TABLES } from "./schema.ts";
import type { ObjectsStore } from "./store.ts";
import type { StoreWrite } from "./writes.ts";

export const OUTBOX_FORMAT = 1;
export type OutboxCommit = {
	readonly seq: number;
	readonly nextId: number;
	readonly writes: readonly StoreWrite[];
};
export class Outbox {
	readonly #store: ObjectsStore;
	#floor: number;
	#tail = Promise.resolve();
	constructor(store: ObjectsStore, floor: number) {
		this.#store = store;
		this.#floor = floor;
	}
	get floor(): number {
		return this.#floor;
	}
	#enqueue<T>(work: () => Promise<T>): Promise<T> {
		const result = this.#tail.then(work);
		this.#tail = result.then(
			() => {},
			() => {},
		);
		return result;
	}
	async read(afterSeq: number, limit: number, context: Context): Promise<OutboxCommit[]> {
		if (!Number.isSafeInteger(afterSeq)) throw invalid("args", `outbox: read after ${afterSeq}, not an integer`);
		if (!Number.isSafeInteger(limit) || limit < 1) throw invalid("args", "outbox: limit is a positive integer");
		return this.#enqueue(async () => {
			if (afterSeq < this.#floor || afterSeq > this.#store.lastSeq)
				throw invalid("args", `outbox: read after ${afterSeq}, outside ${this.#floor}..${this.#store.lastSeq}`);
			const rows = await this.#store.read(
				(executor) =>
					executor.all<{
						seq: number;
						format: number;
						next_id: number;
						writes: string;
					}>(
						`SELECT seq, format, next_id, writes FROM ${TABLES.outbox} WHERE seq > ? ORDER BY seq LIMIT ?`,
						afterSeq,
						limit,
					),
				context,
			);
			return rows.map((row) => {
				if (row.format !== OUTBOX_FORMAT)
					throw new ObjectsError({
						code: "unavailable",
						message: `outbox: commit ${row.seq} is in format ${row.format}, newer than ${OUTBOX_FORMAT}`,
					});
				return {
					seq: row.seq,
					nextId: row.next_id,
					writes: JSON.parse(row.writes) as StoreWrite[],
				};
			});
		});
	}
	async trim(throughSeq: number, context: Context): Promise<void> {
		context.abortSignal?.throwIfAborted();
		if (!Number.isSafeInteger(throughSeq) || throughSeq > this.#store.lastSeq)
			throw invalid("args", `outbox: trim through ${throughSeq}, beyond ${this.#store.lastSeq}`);
		return this.#enqueue(async () => {
			if (throughSeq <= this.#floor) return;
			await this.#store.maintain(async (executor) => {
				await executor.run(`DELETE FROM ${TABLES.outbox} WHERE seq <= ?`, throughSeq);
				await executor.run(`UPDATE ${TABLES.meta} SET outbox_floor = ? WHERE singleton = 1`, throughSeq);
			});
			this.#floor = throughSeq;
		});
	}
}
