import type {
	Context,
	JsonValue,
	ReplicatedStateSource,
	ReplicatedStateSourceAttachment,
	ReplicatedStateSourceFrame,
} from "@axi/chord";
import { withoutAbortSignal } from "@axi/chord/context";
import type { Op } from "@axi/chord/delta";
import { errorMessage } from "../errors.ts";
import type { JsonObject, WatchEnd, WatchHandle } from "../types.ts";
export type ObservedDocumentValue = Readonly<JsonObject> | null;
export const RETIREMENT_OPERATIONS: readonly Op[] = [["r", null]];

class SourceAttachment<Value> implements ReplicatedStateSourceAttachment<Value> {
	readonly snapshot: { readonly value: Value; readonly cursor: number };
	#release: (() => void) | undefined;
	readonly #queue: ReplicatedStateSourceFrame<Value>[] = [];
	#listener: ((frame: ReplicatedStateSourceFrame<Value>) => void) | undefined;
	#active = false;
	#disposed = false;
	#scheduled = false;
	#draining = false;
	constructor(value: Value, cursor: number, release: () => void) {
		this.snapshot = { value, cursor };
		this.#release = release;
	}
	activate(listener: (frame: ReplicatedStateSourceFrame<Value>) => void): void {
		if (this.#active) throw new Error("State attachment is already active");
		if (this.#disposed) throw new Error("State attachment is disposed");
		this.#active = true;
		this.#listener = listener;
		this.#drain();
	}
	publish(frame: ReplicatedStateSourceFrame<Value>): void {
		if (this.#disposed) return;
		this.#queue.push(frame);
		if (!this.#active || this.#scheduled || this.#draining) return;
		this.#scheduled = true;
		queueMicrotask(() => {
			this.#scheduled = false;
			try {
				this.#drain();
			} catch {
				this.dispose();
			}
		});
	}
	#drain(): void {
		if (this.#disposed || this.#draining || !this.#listener) return;
		this.#draining = true;
		try {
			while (!this.#disposed && this.#queue.length) this.#listener(this.#queue.shift()!);
		} finally {
			this.#draining = false;
		}
	}
	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#queue.length = 0;
		this.#listener = undefined;
		const release = this.#release;
		this.#release = undefined;
		release?.();
	}
}
export class CommittedStateSource<Value = ObservedDocumentValue> implements ReplicatedStateSource<Value> {
	readonly #attachments = new Set<SourceAttachment<Value>>();
	#state: { value: Value; cursor: number; retired: boolean } | undefined;
	#release: (() => void) | undefined;
	constructor(value: Value, release: () => void) {
		this.#state = { value, cursor: 0, retired: false };
		this.#release = release;
	}
	attach(): ReplicatedStateSourceAttachment<Value> {
		if (!this.#state) throw new Error("State source is closed");
		const attachment = new SourceAttachment(this.#state.value, this.#state.cursor, () => {
			this.#attachments.delete(attachment);
			if (!this.#attachments.size) this.#dispose();
		});
		this.#attachments.add(attachment);
		return attachment;
	}
	advance(value: Value, ops: readonly Op[], context: Context): void {
		const state = this.#state;
		if (!state || state.retired) return;
		state.value = value;
		state.retired = value === null;
		const frame = { value, ops, context, cursor: ++state.cursor };
		for (const attachment of [...this.#attachments]) attachment.publish(frame);
	}
	closeSession(): void {
		for (const attachment of [...this.#attachments]) attachment.dispose();
		this.#dispose();
	}
	#dispose(): void {
		if (!this.#state) return;
		this.#state = undefined;
		const release = this.#release;
		this.#release = undefined;
		release?.();
	}
}

type WatchFrame<Value> = { readonly value: Value; readonly ops: readonly Op[]; readonly context: Context };
export class CommittedWatch<Value = ObservedDocumentValue> implements WatchHandle<Value> {
	readonly #end = Promise.withResolvers<WatchEnd>();
	readonly #detach: () => void;
	readonly #report: (error: unknown) => void;
	readonly #replacement: (() => Value) | undefined;
	readonly #queue: WatchFrame<Value>[] = [];
	#value: Value;
	#listener: ((value: Value, ops: readonly Op[], context: Context) => Promise<void>) | undefined;
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
	start(listener: (value: Value, ops: readonly Op[], context: Context) => Promise<void>): void {
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
	closeSession(failure?: { readonly error: unknown }): void {
		this.#finish(failure ? { reason: "session_failed", error: failure.error } : { reason: "session_closed" });
	}
	advance(value: Value, ops: readonly Op[], context: Context): void {
		if (this.#terminal || this.#retired) return;
		this.#retired = value === null;
		if (this.#queue.length >= 100) {
			this.#queue.length = 0;
			const replacement = this.#replacement?.() ?? value;
			this.#queue.push({ value: replacement, ops: [["r", replacement as JsonValue]], context });
		} else this.#queue.push({ value, ops, context });
		if (this.#started) this.#schedule();
	}
	#schedule(): void {
		if (this.#terminal || this.#running || this.#scheduled) return;
		this.#scheduled = true;
		queueMicrotask(() => {
			this.#scheduled = false;
			void this.#deliver();
		});
	}
	async #deliver(): Promise<void> {
		if (this.#terminal || this.#running || !this.#listener) return;
		this.#running = true;
		try {
			while (!this.#terminal && this.#queue.length) {
				const frame = this.#queue.shift()!;
				this.#value = frame.value;
				try {
					await this.#listener(frame.value, frame.ops, withoutAbortSignal(frame.context));
				} catch (error) {
					if (!this.#terminal) {
						this.#report(error);
						this.#finish({
							reason: "listener_error",
							error: error instanceof Error ? error : new Error(errorMessage(error)),
						});
					}
					break;
				}
				if (frame.value === null) this.#finish({ reason: "retired" });
			}
		} finally {
			this.#running = false;
			if (!this.#terminal && this.#queue.length) this.#schedule();
		}
	}
	#finish(end: WatchEnd): void {
		if (this.#terminal) return;
		this.#terminal = true;
		this.#detach();
		this.#queue.length = 0;
		if (this.#cancel) this.#cancel.signal.removeEventListener("abort", this.#cancel.callback);
		this.#end.resolve(end);
	}
}
