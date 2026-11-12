import type { Context } from "../context/index.ts";
import { NativeWatch, type NativeWatchable, type NativeWatchHandle, type WatchEnd } from "../watch.ts";
import type { Batch } from "./batch.ts";
import type { NativeObservation, NativeObserver } from "./observation.ts";
import { type Dependent, handedOut } from "./watchable.ts";
export type { NativeObservation, NativeObserver } from "./observation.ts";

export type NativeStart<T> =
	| { readonly kind: "value"; readonly value: T }
	| { readonly kind: "failed"; readonly error: unknown; readonly last: { readonly value: T } | undefined };
type Shown<T> = { readonly kind: "value"; readonly value: T } | { readonly kind: "failed" | "none" };
const nothing = (): void => {};
const ended: WatchEnd = { kind: "ended" };
const abortedEnd: WatchEnd = { kind: "aborted" };

export abstract class NativeSource<T = unknown> implements NativeWatchable<T> {
	readonly dependents = new Set<Dependent>();
	#batch: Batch | undefined;
	constructor(batch: Batch | undefined) { this.#batch = batch }
	abstract get value(): T;
	abstract watch(context: Context): Promise<NativeWatchHandle<T>>;
	start(): NativeStart<T> { return { kind: "value", value: this.value } }
	current(): T { return this.value }
	protected get batch(): Batch | undefined { return this.#batch }
	protected changed(): void { for (const dependent of this.dependents) dependent.invalidate() }
	protected end(): void { this.#batch = undefined; this.dependents.clear() }
}

export abstract class FollowedSource<T = unknown> extends NativeSource<T> {
	readonly #watches = new Set<NativeWatch<T>>();
	readonly #observers = new Map<NativeObserver<T>, () => void>();
	#shown: Shown<T> | undefined;
	#listed = false;
	get watched(): boolean { return this.#watches.size > 0 || this.#observers.size > 0 }
	async watch(context: Context): Promise<NativeWatch<T>> { return this.openWatch(context) }
	openWatch(context: Context): NativeWatch<T> {
		const batch = this.batch;
		if (!batch) {
			const watch = new NativeWatch(this.value, nothing, nothing);
			watch.end(ended);
			return watch;
		}
		batch.assertOutside("watch");
		const initial = this.start();
		const value = this.#valueOf(initial);
		this.#follow(initial);
		const watch = new NativeWatch(value, () => {
			this.#watches.delete(watch);
			this.#idle();
		}, batch.reportListener);
		this.#watches.add(watch);
		if (context.abortSignal) watch.observeAbort(context.abortSignal);
		if (initial.kind === "failed") watch.fail(handedOut(initial.error), context);
		return watch;
	}
	observe(observer: NativeObserver<T>, context: Context): NativeObservation<T> {
		this.batch?.assertOutside("observe");
		const initial = this.start();
		const value = this.#valueOf(initial);
		if (!this.batch) {
			observer.end(ended);
			return { value, detach: nothing };
		}
		const signal = context.abortSignal;
		if (signal?.aborted) {
			observer.end(abortedEnd);
			return { value, detach: nothing };
		}
		const aborted = () => {
			if (!this.#observers.has(observer)) return;
			this.unsubscribe(observer);
			observer.end(abortedEnd);
		};
		signal?.addEventListener("abort", aborted, { once: true });
		this.#follow(initial);
		this.#observers.set(observer, signal ? () => signal.removeEventListener("abort", aborted) : nothing);
		return { value, detach: () => this.unsubscribe(observer) };
	}
	subscribe(observer: NativeObserver<T>): void {
		if (!this.batch) return;
		this.#follow(this.#available());
		this.#observers.set(observer, nothing);
	}
	unsubscribe(observer: NativeObserver<T>): void {
		const cleanup = this.#observers.get(observer);
		if (!cleanup) return;
		this.#observers.delete(observer);
		cleanup();
		this.#idle();
	}
	deliver(context: Context): void {
		this.#listed = false;
		const previous = this.#shown;
		if (!previous) return;
		const next = this.#available();
		if (next.kind === "value" && (previous.kind !== "value" || previous.value !== next.value)) {
			this.#shown = next;
			for (const watch of this.#watches) watch.advance(next.value, context);
			for (const observer of [...this.#observers.keys()]) observer.advance({ kind: "value", value: next.value }, context);
		} else if (next.kind === "failed" && previous.kind === "value") {
			this.#shown = { kind: "failed" };
			const call = { kind: "failed", error: handedOut(next.error) } as const;
			for (const watch of this.#watches) watch.fail(call.error, context);
			for (const observer of [...this.#observers.keys()]) observer.advance({ kind: "failed", error: call.error }, context);
		}
		this.#idle();
	}
	protected override changed(): void { super.changed(); this.list() }
	protected list(): void {
		if (this.#listed || !this.watched || !this.batch) return;
		this.#listed = true;
		this.#shown ??= { kind: "none" };
		this.batch.changed(this);
	}
	protected unfollowed(): void {}
	protected override end(): void {
		super.end();
		this.#shown = undefined;
		for (const watch of this.#watches) watch.end(ended);
		const observers = [...this.#observers];
		this.#observers.clear();
		for (const [observer, cleanup] of observers) { cleanup(); observer.end(ended) }
	}
	#valueOf(initial: NativeStart<T>): T {
		if (initial.kind === "value") return initial.value;
		if (initial.last) return initial.last.value;
		throw initial.error;
	}
	#available(): NativeStart<T> | { readonly kind: "none" } {
		const initial = this.start();
		return initial.kind === "failed" && !initial.last ? { kind: "none" } : initial;
	}
	#follow(initial: NativeStart<T> | { readonly kind: "none" }): void {
		this.#shown ??= initial.kind === "failed" ? { kind: "failed" } : initial;
	}
	#idle(): void {
		if (this.#watches.size || this.#observers.size) return;
		this.#shown = undefined;
		this.unfollowed();
	}
}
