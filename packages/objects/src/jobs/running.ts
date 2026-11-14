import type { Context } from "../context/index.ts";
import type { NonEmptyPath, Op } from "../delta/index.ts";
import type { JsonValue } from "../json.ts";
import { ObjectsError } from "../data/index.ts";
import { Source, type Batch } from "../state/internal.ts";
import type { BlockedReason } from "./run.ts";

export type RunningEntry<A, S> =
	| ({
			readonly id: string;
			readonly version: number;
			readonly key?: string;
			readonly args: A;
			readonly phase: "running" | "finishing";
	  } & ([S] extends [undefined] ? unknown : { readonly state: S }))
	| {
			readonly id: string;
			readonly version: number;
			readonly phase: "blocked";
			readonly reason: BlockedReason;
	  };

export class Running extends Source {
	readonly #label: string;
	#entries: JsonValue[] | undefined = [];
	#pendingOps: Op[] = [];
	#marked = false;
	constructor(batch: Batch, label: string) {
		super(batch);
		this.#label = label;
	}
	get value(): JsonValue {
		return this.#current();
	}
	add(entry: JsonValue): void {
		const entries = this.#current();
		this.#entries = [...entries, entry];
		if (this.#mark()) this.#pendingOps.push(["p", [], entries.length, 0, [entry]]);
	}
	replace(before: JsonValue, after: JsonValue): void {
		const index = this.#replace(before, after);
		if (this.#mark()) this.#pendingOps.push(["s", [index], after]);
	}
	stateChanged(before: JsonValue, after: JsonValue, ops: readonly Op[]): void {
		const index = this.#replace(before, after);
		if (this.#mark()) for (const op of ops) this.#pendingOps.push(nested(index, op));
	}
	remove(entry: JsonValue): void {
		const entries = this.#current(),
			index = entries.indexOf(entry);
		this.#entries = entries.toSpliced(index, 1);
		if (this.#mark()) this.#pendingOps.push(["p", [], index, 1, []]);
	}
	deliver(context: Context): void {
		const ops = this.#pendingOps;
		this.#pendingOps = [];
		this.#marked = false;
		this.publish(this.#current(), ops, false, context);
	}
	end(): void {
		this.#entries = undefined;
		this.#pendingOps = [];
		this.endWatches();
	}
	#current(): JsonValue[] {
		if (!this.#entries)
			throw new ObjectsError({
				code: "released",
				reason: "ended",
				message: `${this.#label}: ended`,
			});
		return this.#entries;
	}
	#replace(before: JsonValue, after: JsonValue): number {
		const entries = this.#current(),
			index = entries.indexOf(before);
		this.#entries = entries.with(index, after);
		return index;
	}
	#mark(): boolean {
		if (!this.watched) {
			this.changed();
			return false;
		}
		if (!this.#marked) {
			this.#marked = true;
			this.changed();
		}
		return true;
	}
}
function nested(index: number, op: Op): Op {
	const prefix: NonEmptyPath = [index, "state"];
	if (op[0] === "r") return ["s", prefix, op[1]];
	const path: NonEmptyPath = [index, "state", ...op[1]];
	switch (op[0]) {
		case "s":
			return ["s", path, op[2]];
		case "d":
			return ["d", path];
		case "a":
			return ["a", path, op[2]];
		case "t":
			return ["t", path, op[2]];
		case "p":
			return ["p", path, op[2], op[3], op[4]];
		case "m":
			return ["m", path, op[2]];
	}
}
