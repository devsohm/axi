import { BACKGROUND_CONTEXT, type Context } from "../../context/index.ts";
import { Source } from "../state/internal.ts";

export type ActivityCounts = {
	readonly references: number;
	readonly calls: number;
	readonly jobs: number;
	readonly lingering: number;
};
export class Activity extends Source {
	readonly #counts = { references: 0, calls: 0, jobs: 0, lingering: 0 };
	#snapshot: ActivityCounts | undefined;
	#queued = false;
	get value(): ActivityCounts {
		return (this.#snapshot ??= { ...this.#counts });
	}
	count(kind: keyof ActivityCounts, delta: number): void {
		this.#counts[kind] += delta;
		this.#snapshot = undefined;
		if (this.#queued || (!this.watched && !this.dependents.size)) return;
		this.#queued = true;
		queueMicrotask(() => {
			this.#queued = false;
			this.batch.within(() => this.changed(), BACKGROUND_CONTEXT);
		});
	}
	deliver(context: Context): void {
		const value = this.value;
		this.publish(value, [["r", value]], false, context);
	}
}
