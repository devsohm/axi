import type { Context } from "../../context/index.ts";
import type { Op } from "../../delta/index.ts";
import type { JsonValue } from "../../json.ts";
import { Watch, type Watchable, type WatchCall, type WatchEnd } from "../../watch.ts";
import type { Batch } from "./batch.ts";

export interface Subscriber {
	advance(call: WatchCall<JsonValue>, context: Context): void;
	end(end: WatchEnd): void;
	endAfterDelivery(): void;
}
export interface Dependent {
	invalidate(): void;
	sourceRetired(visited: Set<Dependent>): void;
}
export type WatchStart =
	| { readonly kind: "value"; readonly value: JsonValue }
	| { readonly kind: "failed"; readonly error: unknown; readonly last: JsonValue | undefined };
const ended: WatchEnd = { kind: "ended" };

export function handedOut<E>(error: E): E {
	if (error instanceof Error) void error.stack;
	return error;
}

export abstract class Source implements Watchable<JsonValue> {
	readonly dependents = new Set<Dependent>();
	protected readonly batch: Batch;
	readonly #watches = new Set<Watch<JsonValue>>();
	readonly #subscribers = new Set<Subscriber>();
	constructor(batch: Batch) { this.batch = batch }
	abstract get value(): JsonValue;
	abstract deliver(context: Context): void;
	get watched(): boolean { return this.#watches.size > 0 || this.#subscribers.size > 0 }
	start(): WatchStart { return { kind: "value", value: this.value } }
	async watch(context: Context): Promise<Watch<JsonValue>> { return this.openWatch(context) }
	openWatch(context: Context): Watch<JsonValue> {
		this.batch.assertOutside("watch");
		const initial = this.start();
		let value: JsonValue;
		if (initial.kind === "value") value = initial.value;
		else {
			if (initial.last === undefined) throw initial.error;
			value = initial.last;
		}
		const watch = new Watch(value, () => { this.#watches.delete(watch) }, this.batch.reportListener);
		this.#watches.add(watch);
		if (context.abortSignal) watch.observeAbort(context.abortSignal);
		if (initial.kind === "failed") watch.fail(initial.error, context);
		return watch;
	}
	subscribe(subscriber: Subscriber): void { this.#subscribers.add(subscriber) }
	unsubscribe(subscriber: Subscriber): void { this.#subscribers.delete(subscriber) }
	protected changed(): void {
		if (this.watched) this.batch.changed(this);
		for (const dependent of this.dependents) dependent.invalidate();
	}
	protected retiredInBatch(): void {
		const visited = new Set<Dependent>();
		for (const dependent of this.dependents) dependent.sourceRetired(visited);
	}
	protected publish(value: JsonValue, ops: readonly Op[], retired: boolean, context: Context): void {
		this.forward({ kind: "value", value, ops, retired }, context);
	}
	protected forward(call: WatchCall<JsonValue>, context: Context): void {
		for (const watch of this.#watches) watch.advance(call, context);
		for (const subscriber of this.#subscribers) subscriber.advance(call, context);
	}
	protected failWatches(error: unknown, context: Context): void {
		this.forward({ kind: "failed", error: handedOut(error) }, context);
	}
	protected endWatchesAfterDelivery(): void {
		for (const watch of [...this.#watches]) watch.endAfterDelivery();
		const subscribers = [...this.#subscribers];
		this.#subscribers.clear();
		for (const subscriber of subscribers) subscriber.endAfterDelivery();
	}
	protected endWatches(): void {
		for (const watch of this.#watches) watch.end(ended);
		const subscribers = [...this.#subscribers];
		this.#subscribers.clear();
		for (const subscriber of subscribers) subscriber.end(ended);
	}
}

export class Constant<T extends JsonValue = JsonValue> implements Watchable<T> {
	readonly value: T;
	constructor(value: T) { this.value = value }
	async watch(context: Context): Promise<Watch<T>> { return this.openWatch(context) }
	openWatch(context: Context): Watch<T> {
		const watch = new Watch(this.value, () => {}, () => {});
		if (context.abortSignal) watch.observeAbort(context.abortSignal);
		return watch;
	}
}
export function constant<const T extends JsonValue>(value: T): Watchable<T> { return new Constant(value) }
