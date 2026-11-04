import { BACKGROUND_CONTEXT, type Context } from "../../context/index.ts";
import { NativeWatch } from "../../watch.ts";
import type { FailureCause, ObjectsError } from "../data/index.ts";
import { NativeSource, type Batch } from "../state/internal.ts";

export type RefState =
	| { readonly kind: "loading" }
	| { readonly kind: "live" }
	| {
			readonly kind: "failed";
			readonly cause: FailureCause;
			readonly retryAt: number | undefined;
	  }
	| { readonly kind: "ended"; readonly error: ObjectsError };
export type Failed = Extract<RefState, { readonly kind: "failed" }>;
export type Ended = Extract<RefState, { readonly kind: "ended" }>;
export const LOADING: RefState = { kind: "loading" };
export const LIVE: RefState = { kind: "live" };
const nothing = (): void => {};

export class ReferenceState extends NativeSource<RefState> {
	readonly #read: () => RefState;
	readonly #watches = new Map<NativeWatch<RefState>, Context>();
	#previous: RefState;
	constructor(read: () => RefState, batch: Batch | undefined) {
		super(batch);
		this.#read = read;
		this.#previous = read();
	}
	get value(): RefState {
		return this.#read();
	}
	async watch(context: Context): Promise<NativeWatch<RefState>> {
		const state = this.#read(),
			batch = this.batch;
		if (!batch || state.kind === "ended") {
			const watch = new NativeWatch<RefState>(state, nothing, nothing);
			watch.end({ kind: "ended" });
			return watch;
		}
		batch.assertOutside("watch");
		const watch = new NativeWatch<RefState>(
			state,
			() => {
				this.#watches.delete(watch);
			},
			batch.reportListener,
		);
		this.#watches.set(watch, context);
		if (context.abortSignal) watch.observeAbort(context.abortSignal);
		return watch;
	}
	moved(): void {
		const state = this.#read();
		if (state === this.#previous) return;
		this.#previous = state;
		for (const [watch, context] of this.#watches) watch.advance(state, context);
		if (this.dependents.size) this.batch?.within(() => this.changed(), BACKGROUND_CONTEXT);
	}
	released(ended: Ended): void {
		this.#previous = ended;
		for (const watch of this.#watches.keys()) watch.end({ kind: "ended" });
		const batch = this.batch;
		if (!batch || !this.dependents.size) {
			this.end();
			return;
		}
		batch.within(() => {
			this.changed();
			this.end();
		}, BACKGROUND_CONTEXT);
	}
}
