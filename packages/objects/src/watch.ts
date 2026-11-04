import { type Context, withoutAbortSignal } from "./context/index.ts";
import { type Op, PendingOps } from "./delta/index.ts";
import type { JsonValue } from "./json.ts";

export type WatchEnd =
	| { readonly kind: "stopped" | "aborted" | "ended" }
	| { readonly kind: "listener_error"; readonly error: Error }
	| { readonly kind: "failed"; readonly error: unknown };
const stopped: WatchEnd = { kind: "stopped" };
const aborted: WatchEnd = { kind: "aborted" };
const ended: WatchEnd = { kind: "ended" };
type FailureCall = { readonly kind: "failed"; readonly error: unknown };
type ValueCall<Value> = { readonly kind: "value"; readonly value: Value };
export type WatchCall<Value> =
	| (ValueCall<Value> & { readonly ops: readonly Op[]; readonly retired: boolean })
	| FailureCall;
export type NativeWatchCall<Value> = ValueCall<Value> | FailureCall;
type Listener<Call> = (call: Call, context: Context) => Promise<void>;

export interface WatchHandle<Value> {
	readonly value: Value;
	readonly closed: Promise<WatchEnd>;
	start(listener: (call: WatchCall<Value>, context: Context) => Promise<void>): void;
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
	start(listener: (call: NativeWatchCall<Value>, context: Context) => Promise<void>): void;
	stop(): Promise<WatchEnd>;
}

abstract class WatchQueue<Value, Call extends ValueCall<Value> | FailureCall> {
	readonly #closed = Promise.withResolvers<WatchEnd>();
	#detach: (() => void) | undefined;
	#report: ((error: unknown) => void) | undefined;
	#value: Value;
	#listener: Listener<Call> | undefined;
	#started = false;
	#scheduled = false;
	#running = false;
	#finishing = false;
	#terminal: WatchEnd | undefined;
	#abort: { signal: AbortSignal; callback: () => void } | undefined;

	constructor(value: Value, detach: () => void, report: (error: unknown) => void) {
		this.#value = value;
		this.#detach = detach;
		this.#report = report;
	}
	get value(): Value {
		return this.#value;
	}
	get closed(): Promise<WatchEnd> {
		return this.#closed.promise;
	}
	start(listener: Listener<Call>): void {
		if (this.#started) throw new Error("Watch is already started");
		if (this.#terminal) throw new Error("Watch is stopped");
		this.#started = true;
		this.#listener = listener;
		this.pending();
	}
	stop(): Promise<WatchEnd> {
		this.#finish(stopped);
		return this.closed;
	}
	abort(): void {
		this.#finish(aborted);
	}
	observeAbort(signal: AbortSignal): void {
		if (this.#abort) throw new Error("Watch abort is already installed");
		if (this.#terminal) return;
		const callback = () => this.abort();
		this.#abort = { signal, callback };
		signal.addEventListener("abort", callback, { once: true });
		if (signal.aborted) callback();
	}
	end(end: WatchEnd): void {
		this.#finish(end);
	}
	endAfterDelivery(): void {
		if (this.#terminal || this.#finishing) return;
		this.#finishing = true;
		if (!this.#running && this.pendingContext === undefined) this.#finish(ended);
	}
	protected get open(): boolean {
		return this.#terminal === undefined && !this.#finishing;
	}
	protected abstract get pendingContext(): Context | undefined;
	protected abstract consume(): Call;
	protected abstract clear(): void;
	protected pending(): void {
		if (!this.#started || this.#terminal || this.#running || this.#scheduled) return;
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
			while (this.#terminal === undefined) {
				const listener = this.#listener;
				if (listener === undefined) break;
				const context = this.pendingContext;
				if (context === undefined) {
					if (this.#finishing) this.#finish(ended);
					break;
				}
				const call = this.consume();
				if (call.kind === "value") this.#value = call.value;
				try {
					await listener(call, withoutAbortSignal(context));
				} catch (error) {
					if (this.#terminal === undefined) {
						this.#report?.(error);
						this.#finish({ kind: "listener_error", error: listenerError(error) });
					}
					break;
				}
			}
		} finally {
			this.#running = false;
		}
	}
	#finish(end: WatchEnd): void {
		if (this.#terminal !== undefined) return;
		this.#terminal = end;
		const detach = this.#detach;
		this.#detach = undefined;
		this.#report = undefined;
		this.#listener = undefined;
		this.clear();
		if (this.#abort) this.#abort.signal.removeEventListener("abort", this.#abort.callback);
		this.#abort = undefined;
		detach?.();
		this.#closed.resolve(end);
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

export class Watch<Value> extends WatchQueue<Value, WatchCall<Value>> implements WatchHandle<Value> {
	readonly #ops = new PendingOps();
	#alone: Extract<WatchCall<Value>, { kind: "value" }> | undefined;
	#latest: Value | undefined;
	#context: Context | undefined;
	#retired = false;
	#failure: FailureCall | undefined;
	#recovering = false;

	advance(call: WatchCall<Value>, context: Context): void {
		if (!this.open) return;
		if (call.kind === "failed") {
			this.#ops.take();
			this.#alone = undefined;
			this.#latest = undefined;
			this.#failure = call;
			this.#recovering = true;
		} else {
			if (this.#recovering) this.#failure = undefined;
			else {
				this.#alone = this.#context === undefined ? call : undefined;
				this.#ops.push(call.ops);
			}
			this.#latest = call.value;
			this.#retired ||= call.retired;
		}
		this.#context = context;
		this.pending();
	}
	fail(error: unknown, context: Context): void {
		this.advance({ kind: "failed", error }, context);
	}
	protected get pendingContext(): Context | undefined {
		return this.#context;
	}
	protected consume(): WatchCall<Value> {
		this.#context = undefined;
		const failure = this.#failure;
		if (failure !== undefined) {
			this.#failure = undefined;
			return failure;
		}
		const alone = this.#alone;
		const value = this.#latest as Value;
		const retired = this.#retired;
		const batch = this.#ops.take();
		const replace = this.#recovering || batch.kind === "replace";
		this.#alone = undefined;
		this.#latest = undefined;
		this.#retired = false;
		this.#recovering = false;
		if (alone !== undefined && !replace) return alone;
		const ops: readonly Op[] = replace ? [["r", value as JsonValue]] : batch.ops;
		return { kind: "value", value, ops, retired };
	}
	protected clear(): void {
		this.#ops.take();
		this.#alone = undefined;
		this.#latest = undefined;
		this.#context = undefined;
		this.#retired = false;
		this.#failure = undefined;
		this.#recovering = false;
	}
}

export class NativeWatch<Value> extends WatchQueue<Value, NativeWatchCall<Value>> implements NativeWatchHandle<Value> {
	// Consecutive slots hold a value and its context; consumed slots release their references immediately.
	readonly #queue: Array<Value | Context | undefined> = [];
	#head = 0;
	#replacement: (() => Value) | undefined;
	#failure: FailureCall | undefined;
	#failureContext: Context | undefined;

	constructor(value: Value, detach: () => void, report: (error: unknown) => void, replace?: () => Value) {
		super(value, detach, report);
		this.#replacement = replace;
	}
	advance(value: Value, context: Context): void {
		if (!this.open) return;
		this.#failure = undefined;
		this.#failureContext = undefined;
		if (this.#queue.length - this.#head >= 200) {
			this.#queue.length = 0;
			this.#head = 0;
			value = this.#replacement === undefined ? value : this.#replacement();
		}
		this.#queue.push(value, context);
		this.pending();
	}
	fail(error: unknown, context: Context): void {
		if (!this.open) return;
		this.#queue.length = 0;
		this.#head = 0;
		this.#failure = { kind: "failed", error };
		this.#failureContext = context;
		this.pending();
	}
	protected get pendingContext(): Context | undefined {
		return this.#failureContext ?? (this.#queue[this.#head + 1] as Context | undefined);
	}
	protected consume(): NativeWatchCall<Value> {
		if (this.#failure !== undefined) {
			const call = this.#failure;
			this.#failure = undefined;
			this.#failureContext = undefined;
			return call;
		}
		const value = this.#queue[this.#head] as Value;
		this.#queue[this.#head] = undefined;
		this.#queue[this.#head + 1] = undefined;
		this.#head += 2;
		if (this.#head === this.#queue.length || this.#head >= 200) {
			this.#queue.copyWithin(0, this.#head);
			this.#queue.length -= this.#head;
			this.#head = 0;
		}
		return { kind: "value", value };
	}
	protected clear(): void {
		this.#queue.length = 0;
		this.#head = 0;
		this.#replacement = undefined;
		this.#failure = undefined;
		this.#failureContext = undefined;
	}
}
