import { BACKGROUND_CONTEXT, type Context } from "./context/index.ts";
import { type Draft, type Prepared, type Tracker, track } from "./delta/index.ts";
import type { Op } from "./delta/index.ts";

export interface ReplicatedStateDelivery {
	readonly kind: "hydrate" | "update";
	readonly sequence: number;
}
type Listener<T> = (value: T, context: Context, delivery: ReplicatedStateDelivery) => void;
export interface ReplicatedState<T> {
	readonly value: T | undefined;
	subscribe(listener: (value: T, context: Context, delivery: ReplicatedStateDelivery) => Promise<void>): () => void;
	subscribe(listener: Listener<T>): () => void;
}
export interface MutableReplicatedState<T extends object> extends ReplicatedState<T> {
	readonly value: T;
	change(context: Context, mutate: (draft: Draft<T>) => void): void;
	replace(context: Context, value: T): void;
}
export interface ReplicatedStateSourceFrame<T> {
	readonly cursor: number;
	readonly value: T;
	readonly ops: readonly Op[];
	readonly context: Context;
}
export interface ReplicatedStateSourceAttachment<T> {
	readonly snapshot: { readonly value: T; readonly cursor: number };
	activate(listener: (frame: ReplicatedStateSourceFrame<T>) => void): void;
	dispose(): void;
}
export interface ReplicatedStateSource<T> {
	attach(): ReplicatedStateSourceAttachment<T>;
}
export interface ReplicatedStateSourceOptions {
	readonly onError?: (error: Error) => void;
}
export interface AttachedReplicatedState<T> extends ReplicatedState<T> {
	readonly value: T;
	dispose(): void;
}

const toError = (value: unknown): Error => (value instanceof Error ? value : new Error(String(value)));
const asynchronousError = (error: Error): void => {
	queueMicrotask(() => {
		throw error;
	});
};
function thenable(value: unknown): value is PromiseLike<unknown> {
	return (
		value !== null &&
		(typeof value === "object" || typeof value === "function") &&
		typeof Reflect.get(value, "then") === "function"
	);
}
type Delivery<T> = { readonly value: T; readonly context: Context; readonly delivery: ReplicatedStateDelivery };
class Subscription<T> {
	readonly #listener: Listener<T>;
	readonly #reportError: (error: Error) => void;
	readonly #pending: Delivery<T>[] = [];
	#running = false;
	#started = false;
	#closed = false;
	constructor(listener: Listener<T>, report: (error: Error) => void) {
		this.#listener = listener;
		this.#reportError = report;
	}
	enqueue(item: Delivery<T>): void {
		if (this.#closed) return;
		if (this.#pending.length === 100) {
			const hydration = !this.#started ? this.#pending[0] : undefined;
			this.#pending.length = 0;
			if (hydration) this.#pending.push(hydration);
		}
		this.#pending.push(item);
	}
	drain(): void {
		if (this.#running || this.#closed) return;
		this.#running = true;
		for (let item = this.#pending.shift(); item !== undefined; item = this.#pending.shift()) {
			this.#started = true;
			try {
				const outcome: unknown = this.#listener(item.value, item.context, item.delivery);
				if (thenable(outcome)) {
					void Promise.resolve(outcome).then(
						() => this.#resume(),
						(error: unknown) => {
							this.#report(error);
							this.#resume();
						},
					);
					return;
				}
			} catch (error) {
				this.#report(error);
			}
		}
		this.#running = false;
	}
	#resume(): void {
		this.#running = false;
		this.drain();
	}
	close(): void {
		this.#closed = true;
		this.#pending.length = 0;
	}
	#report(error: unknown): void {
		try {
			this.#reportError(toError(error));
		} catch (failure) {
			asynchronousError(toError(failure));
		}
	}
}
type PendingPublication<T> = { readonly value: T; readonly sequence: number; readonly context: Context };
class Publication<T> {
	#value: T;
	#sequence = 0;
	#delivering = false;
	readonly #pending: PendingPublication<T>[] = [];
	readonly #subscriptions = new Map<Subscription<T>, number>();
	readonly #report: (error: Error) => void;
	constructor(value: T, onError: (error: Error) => void = asynchronousError) {
		this.#value = value;
		this.#report = onError;
	}
	get value(): T {
		return this.#value;
	}
	snapshot(): { readonly value: T; readonly sequence: number } {
		return { value: this.#value, sequence: this.#sequence };
	}
	subscribe(listener: Listener<T>): () => void {
		const { value, sequence } = this.snapshot();
		const subscription = new Subscription(listener, this.#report);
		this.#subscriptions.set(subscription, sequence);
		subscription.enqueue({
			value,
			context: BACKGROUND_CONTEXT,
			delivery: { kind: "hydrate", sequence },
		});
		subscription.drain();
		return () => {
			subscription.close();
			this.#subscriptions.delete(subscription);
		};
	}
	publish(value: T, context: Context): void {
		this.#value = value;
		this.#pending.push({ value, sequence: ++this.#sequence, context });
		if (this.#delivering) return;
		this.#delivering = true;
		try {
			for (let item = this.#pending.shift(); item !== undefined; item = this.#pending.shift()) {
				const delivery = { kind: "update", sequence: item.sequence } as const;
				for (const [subscription, initial] of [...this.#subscriptions]) {
					if (item.sequence <= initial) continue;
					subscription.enqueue({ value: item.value, context: item.context, delivery });
					subscription.drain();
				}
			}
		} finally {
			this.#delivering = false;
		}
	}
}

class MutablePublication<T extends object> implements MutableReplicatedState<T> {
	readonly #revisions: Tracker<T>;
	readonly #publication: Publication<T>;
	#changing = false;
	constructor(initial: T) {
		this.#revisions = track(initial);
		this.#publication = new Publication(this.#revisions.value);
	}
	get value(): T {
		return this.#revisions.value;
	}
	change(context: Context, mutate: (draft: Draft<T>) => void): void {
		if (this.#changing) throw new Error("Replicated state cannot be changed reentrantly from a change callback");
		this.#changing = true;
		let prepared: Prepared<T>;
		try {
			const transaction = this.#revisions.beginChange();
			try {
				const outcome: unknown = mutate(transaction.state);
				if (thenable(outcome)) {
					void Promise.resolve(outcome).catch(() => undefined);
					throw new TypeError("Replicated state change callbacks must be synchronous");
				}
				prepared = transaction.prepare();
			} catch (error) {
				transaction.abort();
				throw error;
			}
		} finally {
			this.#changing = false;
		}
		this.#revisions.adopt(prepared);
		if (prepared.ops.length) this.#publication.publish(prepared.value, context);
	}
	replace(context: Context, value: T): void {
		if (this.#changing) throw new Error("Replicated state cannot be replaced from a change callback");
		const prepared = this.#revisions.prepareReplace(value);
		this.#revisions.adopt(prepared);
		if (prepared.ops.length) this.#publication.publish(prepared.value, context);
	}
	subscribe(listener: Listener<T>): () => void {
		return this.#publication.subscribe(listener);
	}
}

function cursor(value: number, kind: "snapshot" | "frame"): void {
	if (!Number.isSafeInteger(value))
		throw new TypeError(`Replicated state source ${kind} cursor must be a safe integer`);
}
class AttachedPublication<T> implements AttachedReplicatedState<T> {
	readonly #attachment: ReplicatedStateSourceAttachment<T>;
	readonly #publication: Publication<T>;
	readonly #reportError: (error: Error) => void;
	#position: number;
	#disposed = false;
	constructor(attachment: ReplicatedStateSourceAttachment<T>, options: ReplicatedStateSourceOptions) {
		const snapshot = attachment.snapshot;
		cursor(snapshot.cursor, "snapshot");
		this.#position = snapshot.cursor;
		this.#attachment = attachment;
		this.#reportError = options.onError ?? asynchronousError;
		this.#publication = new Publication(snapshot.value, (error) => this.#report(error));
	}
	get value(): T {
		return this.#publication.value;
	}
	subscribe(listener: Listener<T>): () => void {
		return this.#publication.subscribe(listener);
	}
	activate(): void {
		this.#attachment.activate((frame) => this.#receive(frame));
	}
	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#attachment.dispose();
	}
	#receive(frame: ReplicatedStateSourceFrame<T>): void {
		if (this.#disposed) return;
		try {
			cursor(frame.cursor, "frame");
			const expected = this.#position + 1;
			if (frame.cursor !== expected)
				throw new Error(`Replicated state source cursor has a gap: expected ${expected}, received ${frame.cursor}`);
			this.#position = frame.cursor;
			this.#publication.publish(frame.value, frame.context);
		} catch (error) {
			this.#fail(toError(error));
		}
	}
	#fail(error: Error): void {
		if (this.#disposed) return;
		this.#disposed = true;
		try {
			this.#attachment.dispose();
		} catch (failure) {
			this.#report(new AggregateError([error, failure], "Replicated state source contract failed"));
			return;
		}
		this.#report(error);
	}
	#report(error: unknown): void {
		try {
			this.#reportError(toError(error));
		} catch (failure) {
			asynchronousError(toError(failure));
		}
	}
}
function attached<T>(
	source: ReplicatedStateSource<T>,
	options: ReplicatedStateSourceOptions,
): AttachedReplicatedState<T> {
	const attachment = source.attach();
	try {
		const state = new AttachedPublication(attachment, options);
		state.activate();
		return state;
	} catch (error) {
		try {
			attachment.dispose();
		} catch (failure) {
			throw new AggregateError([error, failure], "Failed to attach replicated state source");
		}
		throw error;
	}
}
function source(value: object): value is ReplicatedStateSource<unknown> {
	return typeof Reflect.get(value, "attach") === "function";
}
export function replicatedState<T>(
	source: ReplicatedStateSource<T>,
	options?: ReplicatedStateSourceOptions,
): AttachedReplicatedState<T>;
export function replicatedState<T extends object>(initial: T): MutableReplicatedState<T>;
export function replicatedState(
	value: object,
	options: ReplicatedStateSourceOptions = {},
): MutableReplicatedState<object> | AttachedReplicatedState<unknown> {
	return source(value) ? attached(value, options) : new MutablePublication(value);
}
