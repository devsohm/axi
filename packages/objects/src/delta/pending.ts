import type { Op } from "./index.ts";

export type PendingTake = { readonly kind: "ops"; readonly ops: readonly Op[] } | { readonly kind: "replace" };
export const MAX_PENDING_OPS = 10_000;

type Joined = { kind: "joined"; values: Op[]; slots: Map<string, number> };
type QueueState = { kind: "idle" } | { kind: "batch"; values: readonly Op[] } | Joined | { kind: "overflow" };

const idle: QueueState = { kind: "idle" };
const overflow: QueueState = { kind: "overflow" };
const empty: PendingTake = { kind: "ops", ops: [] };
const replacement: PendingTake = { kind: "replace" };

export class PendingOps {
	#state: QueueState = idle;

	push(ops: readonly Op[]): void {
		if (ops.length === 0) return;
		if (this.#state.kind === "idle" || ops[0]![0] === "r") {
			this.#state = { kind: "batch", values: ops };
			return;
		}
		if (this.#state.kind === "overflow") return;
		if (this.#state.kind === "joined") {
			this.#fold(this.#state, ops);
			return;
		}
		const previous = this.#state.values;
		const joined: Joined = { kind: "joined", values: [], slots: new Map() };
		this.#state = joined;
		if (this.#fold(joined, previous)) this.#fold(joined, ops);
	}

	get size(): number {
		switch (this.#state.kind) {
			case "idle":
				return 0;
			case "overflow":
				return 1;
			default:
				return this.#state.values.length;
		}
	}

	take(): PendingTake {
		const state = this.#state;
		this.#state = idle;
		if (state.kind === "idle") return empty;
		if (state.kind === "overflow") return replacement;
		return { kind: "ops", ops: state.values };
	}

	#fold(target: Joined, incoming: readonly Op[]): boolean {
		for (const op of incoming) {
			if (op[0] === "r") {
				target.values.length = 0;
				target.slots.clear();
			} else if (op[0] === "a" || (op[0] === "s" && (op[2] === null || typeof op[2] !== "object"))) {
				const key = JSON.stringify(op[1]);
				const position = target.slots.get(key);
				if (position !== undefined) {
					const previous = target.values[position]!;
					if (op[0] === "s") {
						target.values[position] = op;
						continue;
					}
					if (previous[0] === "a") {
						target.values[position] = ["a", previous[1], previous[2] + op[2]];
						continue;
					}
					if (previous[0] === "s" && typeof previous[2] === "string") {
						target.values[position] = ["s", previous[1], previous[2] + op[2]];
						continue;
					}
				}
				target.slots.set(key, target.values.length);
			} else {
				target.slots.clear();
			}
			target.values.push(op);
			if (target.values.length > MAX_PENDING_OPS) {
				this.#state = overflow;
				return false;
			}
		}
		return true;
	}
}
