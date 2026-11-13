import type { Context } from "../context/index.ts";
import { diffRevisions, type Op } from "../delta/index.ts";
import type { JsonValue } from "../json.ts";
import { Watch, type WatchCall, type WatchEnd } from "../watch.ts";
import type { ObjectsError } from "../data/index.ts";
import {
	Source,
	handedOut,
	type Batch,
	type Dependent,
	type DeriveSource,
	type Subscriber,
	type WatchStart,
} from "../state/internal.ts";

const ended: WatchEnd = { kind: "ended" };

type MemberState =
	| { readonly kind: "following"; readonly source: DeriveSource }
	| { readonly kind: "frozen"; readonly value: JsonValue; readonly failure?: { readonly error: unknown } }
	| {
			readonly kind: "failed";
			readonly error: unknown;
			readonly last: JsonValue | undefined;
	  }
	| { readonly kind: "ended"; readonly error: ObjectsError };
export class MemberSource extends Source implements Dependent {
	#state: MemberState;
	readonly #listeners = new Set<Subscriber>();
	#previousFrame: { readonly value: JsonValue | undefined } | undefined;
	#interrupted = false;
	#seen: (() => boolean) | undefined;
	constructor(source: DeriveSource, batch: Batch) {
		super(batch);
		this.#state = { kind: "following", source };
		this.#connect(source);
	}
	unseen(seen: () => boolean): void { this.#seen = seen; }
	#startOf(source: DeriveSource): WatchStart {
		const start = source instanceof Source ? source.start() : { kind: "value" as const, value: source.value };
		if (this.#seen === undefined || start.kind === "value") return start;
		if (!this.#seen()) return { kind: "failed", error: start.error, last: undefined };
		this.#seen = undefined;
		return start;
	}
	get value(): JsonValue {
		const state = this.#state;
		if (state.kind === "following") return state.source.value;
		if (state.kind === "frozen") return state.value;
		throw state.error;
	}
	start(): WatchStart {
		const state = this.#state;
		switch (state.kind) {
			case "following":
				return this.#startOf(state.source);
			case "frozen":
				return state.failure === undefined
					? { kind: "value", value: state.value }
					: { kind: "failed", error: state.failure.error, last: state.value };
			case "failed":
				return { kind: "failed", error: state.error, last: state.last };
			case "ended":
				throw state.error;
		}
	}
	get watched(): boolean {
		return this.#listeners.size !== 0;
	}
	openWatch(context: Context): Watch<JsonValue> {
		this.batch.assertOutside("watch");
		const start = this.start();
		if (start.kind === "failed" && start.last === undefined) throw start.error;
		const watch = new Watch(
			start.kind === "value" ? start.value : start.last!,
			() => this.unsubscribe(watch),
			this.batch.reportListener,
		);
		this.subscribe(watch);
		if (context.abortSignal) watch.observeAbort(context.abortSignal);
		if (start.kind === "failed") watch.fail(handedOut(start.error), context);
		return watch;
	}
	subscribe(subscriber: Subscriber): void {
		this.#listeners.add(subscriber);
		if (this.#state.kind === "following" && this.#state.source instanceof Source)
			this.#state.source.subscribe(subscriber);
	}
	unsubscribe(subscriber: Subscriber): void {
		this.#listeners.delete(subscriber);
		if (this.#state.kind === "following" && this.#state.source instanceof Source)
			this.#state.source.unsubscribe(subscriber);
	}
	invalidate(): void {
		for (const dependent of this.dependents) dependent.invalidate();
	}
	sourceRetired(visited: Set<Dependent>): void {
		for (const dependent of this.dependents) dependent.sourceRetired(visited);
	}
	freeze(): void {
		const state = this.#state;
		if (state.kind === "frozen") {
			if (state.failure !== undefined) this.#state = { kind: "frozen", value: state.value };
			return;
		}
		if (state.kind !== "following") return;
		this.#disconnect();
		const start = this.#startOf(state.source);
		this.#state =
			start.kind === "value"
				? { kind: "frozen", value: start.value }
				: { kind: "failed", error: start.error, last: start.last };
	}
	fail(error: ObjectsError, context: Context): void {
		handedOut(error);
		if (this.#state.kind === "following") this.freeze();
		const state = this.#state;
		if (state.kind !== "frozen" || state.failure !== undefined) return;
		this.#state = { ...state, failure: { error } };
		this.#interrupted = true;
		this.#forward({ kind: "failed", error }, context);
	}
	bind(source: DeriveSource): void {
		if (this.#state.kind === "ended" || (this.#state.kind === "following" && this.#state.source === source)) return;
		this.#disconnect();
		if (this.watched) {
			const before = this.start();
			this.#previousFrame = {
				value: this.#interrupted || before.kind === "failed" ? undefined : before.value,
			};
		}
		this.#interrupted = false;
		this.#state = { kind: "following", source };
		this.#connect(source);
		this.changed();
	}
	vanish(error: ObjectsError, context: Context): void {
		if (this.#state.kind === "ended") return;
		const before = this.start(),
			last = before.kind === "value" ? before.value : before.last;
		this.#disconnect();
		this.#state = { kind: "failed", error, last };
		this.#forward({ kind: "failed", error: handedOut(error) }, context);
		this.changed();
	}
	objectEnded(error: ObjectsError): void {
		handedOut(error);
		this.#disconnect();
		this.#state = { kind: "ended", error };
		this.#previousFrame = undefined;
		for (const listener of [...this.#listeners]) listener.end(ended);
		this.#listeners.clear();
		for (const dependent of this.dependents) dependent.invalidate();
	}
	deliver(context: Context): void {
		const frame = this.#previousFrame;
		this.#previousFrame = undefined;
		if (!frame) return;
		let value: JsonValue;
		try {
			value = this.value;
		} catch (error) {
			if (frame.value !== undefined) this.#forward({ kind: "failed", error: handedOut(error) }, context);
			return;
		}
		if (value === frame.value) return;
		const ops: readonly Op[] = frame.value === undefined ? [["r", value]] : diffRevisions(frame.value, value);
		if (ops.length) this.#forward({ kind: "value", value, ops, retired: false }, context);
	}
	#forward(call: WatchCall<JsonValue>, context: Context): void {
		for (const listener of this.#listeners) listener.advance(call, context);
	}
	#connect(source: DeriveSource): void {
		if (!(source instanceof Source)) return;
		source.dependents.add(this);
		for (const listener of this.#listeners) source.subscribe(listener);
	}
	#disconnect(): void {
		if (this.#state.kind !== "following" || !(this.#state.source instanceof Source)) return;
		const source = this.#state.source;
		source.dependents.delete(this);
		for (const listener of this.#listeners) source.unsubscribe(listener);
	}
}
