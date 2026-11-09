import type { Context } from "../context/index.ts";
import { applyImmutable, decoder, type Op } from "../delta/index.ts";
import type { JsonValue } from "../json.ts";
import type { ObjectsError } from "../data/index.ts";
import { handedOut, Source, type Batch, type WatchStart } from "../state/internal.ts";

export type MemberSnapshot =
	| { readonly kind: "value"; readonly value: JsonValue }
	| { readonly kind: "failed"; readonly error: unknown };
type Status =
	| Extract<MemberSnapshot, { readonly kind: "value" }>
	| { readonly kind: "failed"; readonly error: unknown; readonly last: JsonValue | undefined }
	| { readonly kind: "ended"; readonly error: ObjectsError };
const noOps: readonly Op[] = [];
export class Replica extends Source {
	#status: Status;
	#decoder = decoder();
	#ops = noOps;
	#retired = false;
	#retiredWhileFailed = false;
	constructor(batch: Batch, state: MemberSnapshot) {
		super(batch);
		this.#status = state.kind === "value" ? state : { kind: "failed", error: handedOut(state.error), last: undefined };
	}
	get value(): JsonValue {
		if (this.#status.kind === "value") return this.#status.value;
		throw this.#status.error;
	}
	override start(): WatchStart {
		return this.#status.kind === "failed"
			? { kind: "failed", error: this.#status.error, last: this.#status.last }
			: { kind: "value", value: this.value };
	}
	decode(wire: unknown): { readonly value: JsonValue; readonly ops: readonly Op[] } {
		if (!Array.isArray(wire)) throw new Error("part: a member's changes are a list of ops");
		const ops = this.#decoder.decode(wire),
			status = this.#status;
		if (status.kind === "ended") throw status.error;
		if (status.kind === "failed" && ops[0]?.[0] !== "r")
			throw new Error("part: a failed member recovers with a root replacement");
		return { ops, value: applyImmutable(status.kind === "value" ? status.value : null, ops) };
	}
	adopt(value: JsonValue, ops: readonly Op[], retired: boolean): void {
		this.#status = { kind: "value", value };
		this.#ops = ops;
		this.#retired = retired || this.#retiredWhileFailed;
		this.#retiredWhileFailed = false;
		this.changed();
		if (this.#retired) this.retiredInBatch();
	}
	retireAlone(): void {
		if (this.#status.kind === "value") this.adopt(this.#status.value, noOps, true);
		else if (this.#status.kind === "failed") this.#retiredWhileFailed = true;
	}
	reset(state: MemberSnapshot): void {
		this.#decoder = decoder();
		if (state.kind === "failed") this.fail(state.error);
		else this.adopt(state.value, [["r", state.value]], false);
	}
	fail(error: unknown): void {
		const previous = this.#status,
			last = previous.kind === "value" ? previous.value : previous.kind === "failed" ? previous.last : undefined;
		this.#status = { kind: "failed", error: handedOut(error), last };
		if (previous.kind !== "failed") this.changed();
	}
	deliver(context: Context): void {
		if (this.#status.kind === "value") this.publish(this.#status.value, this.#ops, this.#retired, context);
		else if (this.#status.kind === "failed") this.failWatches(this.#status.error, context);
		else this.endWatches();
		this.#ops = noOps;
		this.#retired = false;
	}
	vanish(error: ObjectsError): void {
		this.fail(error);
	}
	end(error: ObjectsError): void {
		this.#status = { kind: "ended", error };
		this.endWatches();
	}
}
