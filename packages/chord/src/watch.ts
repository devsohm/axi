import { type Context, withoutAbortSignal } from "./context/index.ts";
import type { Op } from "./delta/index.ts";
import type { JsonValue } from "./json.ts";

export type WatchEnd =
	| { readonly reason: "stopped" | "cancelled" | "ended" | "retired" }
	| { readonly reason: "listener_error"; readonly error: Error }
	| { readonly reason: "failed"; readonly error: unknown };
export interface WatchHandle<Value> {
	readonly value: Value;
	readonly closed: Promise<WatchEnd>;
	start(listener: (value: Value, ops: readonly Op[], context: Context) => Promise<void>): void;
	stop(): Promise<WatchEnd>;
}

export interface Watchable<Value> {
	readonly value: Value;
	watch(context: Context): Promise<WatchHandle<Value>>;
}
export interface NativeWatchable<Value> {
	readonly value: Value;
	watch(context: Context): Promise<NativeWatchHandle<Value>>;
}
export interface NativeWatchHandle<Value> {
	readonly value: Value;
	readonly closed: Promise<WatchEnd>;
	start(listener: (value: Value, context: Context) => Promise<void>): void;
	stop(): Promise<WatchEnd>;
}

type JsonListener<Value> = (value: Value, ops: readonly Op[], context: Context) => Promise<void>;
type NativeListener<Value> = (value: Value, context: Context) => Promise<void>;
type Frame<Value> = { value: Value; ops: readonly Op[]; context: Context; retires?: true };

abstract class WatchQueue<Value, Listener> {
	readonly #end = Promise.withResolvers<WatchEnd>();
	#detach: (() => void) | undefined;
	#report: ((error: unknown) => void) | undefined;
	#replacement: (() => Value) | undefined;
	readonly #queue: Frame<Value>[] = [];
	#value: Value;
	#listener: Listener | undefined;
	#started = false;
	#scheduled = false;
	#running = false;
	#retired = false;
	#terminal = false;
	#cancel: { signal: AbortSignal; callback: () => void } | undefined;
	constructor(value: Value, detach: () => void, report: (error: unknown) => void, replacement?: () => Value) {
		this.#value = value;
		this.#detach = detach;
		this.#report = report;
		this.#replacement = replacement;
	}
	get value(): Value {
		return this.#value;
	}
	get closed(): Promise<WatchEnd> {
		return this.#end.promise;
	}
	start(listener: Listener): void {
		if (this.#started) throw new Error("Watch is already started");
		if (this.#terminal) throw new Error("Watch is stopped");
		this.#started = true;
		this.#listener = listener;
		if (this.#queue.length) this.#schedule();
	}
	stop(): Promise<WatchEnd> {
		this.#finish({ reason: "stopped" });
		return this.closed;
	}
	cancel(): void {
		this.#finish({ reason: "cancelled" });
	}
	observeCancellation(signal: AbortSignal): void {
		if (this.#cancel) throw new Error("Watch cancellation is already installed");
		if (this.#terminal) return;
		const callback = () => this.cancel();
		this.#cancel = { signal, callback };
		signal.addEventListener("abort", callback, { once: true });
		if (signal.aborted) callback();
	}
	end(failure?: { readonly error: unknown }): void {
		this.#finish(failure === undefined ? { reason: "ended" } : { reason: "failed", error: failure.error });
	}
	protected abstract deliver(listener: Listener, frame: Frame<Value>, context: Context): Promise<void>;
	protected abstract overflow(value: Value): readonly Op[];
	protected enqueue(value: Value, ops: readonly Op[], context: Context): void {
		if (this.#terminal || this.#retired) return;
		if (this.#queue.length >= 100) {
			this.#queue.length = 0;
			const replacement = this.#replacement?.() ?? value;
			this.#queue.push({ value: replacement, ops: this.overflow(replacement), context });
		} else this.#queue.push({ value, ops, context });
		if (this.#started) this.#schedule();
	}
	protected retireFrame(value: Value, ops: readonly Op[], context: Context): void {
		if (this.#terminal || this.#retired) return;
		this.#retired = true;
		if (this.#queue.length >= 100) this.#queue.length = 0;
		this.#queue.push({ value, ops, context, retires: true });
		if (this.#started) this.#schedule();
	}
	#schedule(): void {
		if (this.#terminal || this.#running || this.#scheduled) return;
		this.#scheduled = true;
		queueMicrotask(() => {
			this.#scheduled = false;
			void this.#drain();
		});
	}
	async #drain(): Promise<void> {
		if (this.#terminal || this.#running || !this.#started) return;
		this.#running = true;
		try {
			while (!this.#terminal) {
				const frame = this.#queue.shift(),
					listener = this.#listener;
				if (frame === undefined || listener === undefined) break;
				this.#value = frame.value;
				const context = withoutAbortSignal(frame.context);
				try {
					await this.deliver(listener, frame, context);
				} catch (error) {
					if (!this.#terminal) {
						this.#report?.(error);
						this.#finish({ reason: "listener_error", error: listenerError(error) });
					}
					break;
				}
				if (frame.retires) this.#finish({ reason: "retired" });
			}
		} finally {
			this.#running = false;
			if (!this.#terminal && this.#queue.length) this.#schedule();
		}
	}
	#finish(end: WatchEnd): void {
		if (this.#terminal) return;
		this.#terminal = true;
		const detach = this.#detach;
		this.#detach = undefined;
		this.#report = undefined;
		this.#replacement = undefined;
		this.#listener = undefined;
		this.#queue.length = 0;
		if (this.#cancel) this.#cancel.signal.removeEventListener("abort", this.#cancel.callback);
		this.#cancel = undefined;
		detach?.();
		this.#end.resolve(end);
	}
}
function listenerError(value: unknown): Error {
	if (value instanceof Error) return value;
	try {
		return new Error(String(value));
	} catch {
		return new Error(Object.prototype.toString.call(value));
	}
}
const retirement: readonly Op[] = [["r", null]];
export class Watch<Value> extends WatchQueue<Value, JsonListener<Value>> implements WatchHandle<Value> {
	advance(value: Value, ops: readonly Op[], context: Context): void {
		this.enqueue(value, ops, context);
	}
	retire(this: Watch<Value | null>, context: Context): void {
		this.retireFrame(null, retirement, context);
	}
	protected deliver(listener: JsonListener<Value>, frame: Frame<Value>, context: Context): Promise<void> {
		return listener(frame.value, frame.ops, context);
	}
	protected overflow(value: Value): readonly Op[] {
		return [["r", value as JsonValue]];
	}
}
const noOperations: readonly Op[] = [];
export class NativeWatch<Value> extends WatchQueue<Value, NativeListener<Value>> implements NativeWatchHandle<Value> {
	constructor(value: Value, detach: () => void, report: (error: unknown) => void) {
		super(value, detach, report);
	}
	advance(value: Value, context: Context): void {
		this.enqueue(value, noOperations, context);
	}
	protected deliver(listener: NativeListener<Value>, frame: Frame<Value>, context: Context): Promise<void> {
		return listener(frame.value, context);
	}
	protected overflow(): readonly Op[] {
		return noOperations;
	}
}
