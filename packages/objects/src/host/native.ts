import type { TelemetryContext } from "@axi/telemetry";
import { withAbortSignal, withTelemetry, type Context } from "../context/index.ts";
import { ended, spanFailed, untraced } from "../telemetry.ts";
import { ObjectsError } from "../data/index.ts";
import type { HostError } from "./report.ts";

export type NativeCloseReason = { readonly kind: "end" } | { readonly kind: "close" } | { readonly kind: "reload" };
export interface Native<T> {
	readonly value: T;
}
export type NativeOptions = { readonly closeTimeout?: number };
export type CloseFailed = Extract<HostError, { readonly kind: "close_failed" }>;
type NativeOwner = {
	readonly object: string;
	readonly type: string;
	readonly host: string;
	readonly telemetry?: TelemetryContext;
	readonly position: number;
	readonly context: Context;
	readonly report: (error: HostError) => void;
};
export interface NativeSlot {
	open(context: Context): Promise<void>;
	close(reason: NativeCloseReason): Promise<CloseFailed | undefined>;
}
type NativeState<T> =
	| { readonly kind: "new" | "opening" | "closed" }
	| { readonly kind: "live"; readonly value: T }
	| { readonly kind: "late"; readonly reason: NativeCloseReason };

export class NativeHandle<T> implements Native<T>, NativeSlot {
	readonly #opener: (context: Context) => Promise<T>;
	readonly #closer: (value: T, reason: NativeCloseReason, context: Context) => void | Promise<void>;
	readonly #timeout: number;
	readonly #owner: NativeOwner;
	#state: NativeState<T> = { kind: "new" };
	constructor(
		open: (context: Context) => Promise<T>,
		close: (value: T, reason: NativeCloseReason, context: Context) => void | Promise<void>,
		closeTimeout: number,
		owner: NativeOwner,
	) {
		this.#opener = open;
		this.#closer = close;
		this.#timeout = closeTimeout;
		this.#owner = owner;
	}
	get value(): T {
		if (this.#state.kind === "live") return this.#state.value;
		const message = `${this.#name()}: ${this.#state.kind === "new" || this.#state.kind === "opening" ? "not open yet" : "closed"}`;
		if (this.#state.kind === "new" || this.#state.kind === "opening")
			throw new ObjectsError({ code: "not_ready", message });
		throw new ObjectsError({ code: "released", reason: "closed", message });
	}
	async open(context: Context): Promise<void> {
		this.#state = { kind: "opening" };
		if (untraced(context.telemetry)) return this.#receive(await this.#opener(context));
		const { host, type, position } = this.#owner;
		await context.telemetry.startSpan({ name: "objects.open", attributes: { "objects.host": host, type, native: position } }, async (span) => {
			try { await this.#receive(await this.#opener(withTelemetry(span, context))); }
			catch (error) { ended(span, "open_failed", error, context.abortSignal); throw error; }
		});
	}
	async #receive(value: T): Promise<void> {
		const state = this.#state;
		if (state.kind !== "late") {
			this.#state = { kind: "live", value };
			return;
		}
		this.#state = { kind: "closed" };
		const failure = await this.#close(value, state.reason);
		if (failure) this.#owner.report(failure);
	}
	async close(reason: NativeCloseReason): Promise<CloseFailed | undefined> {
		const state = this.#state;
		this.#state = state.kind === "opening" ? { kind: "late", reason } : { kind: "closed" };
		return state.kind === "live" ? this.#close(state.value, reason) : undefined;
	}
	async #close(value: T, reason: NativeCloseReason): Promise<CloseFailed | undefined> {
		const { host, type, position, telemetry, context } = this.#owner;
		if (!telemetry || untraced(telemetry)) return this.#closeWithin(value, reason, context);
		return telemetry.startSpan({ name: "objects.close", attributes: { "objects.host": host, type, native: position, reason: reason.kind } }, async (span) => {
			const failure = await this.#closeWithin(value, reason, withTelemetry(span, context));
			if (failure) spanFailed(span, "close_failed", failure.error);
			return failure;
		});
	}
	async #closeWithin(value: T, reason: NativeCloseReason, context: Context): Promise<CloseFailed | undefined> {
		const { object, position } = this.#owner,
			native = { kind: "native", position } as const;
		const controller = new AbortController();
		const closing = (async () => this.#closer(value, reason, withAbortSignal(controller.signal, context)))();
		try {
			if ((await within(closing, this.#timeout)) === "timeout") {
				controller.abort(
					new ObjectsError({
						code: "aborted",
						message: `${this.#name()}: close timed out`,
					}),
				);
				this.#owner.report({ kind: "close_timeout", object, native });
			}
		} catch (error) {
			return { kind: "close_failed", object, native, error };
		}
		return undefined;
	}
	#name(): string {
		return `${this.#owner.object} native #${this.#owner.position}`;
	}
}
export async function within(promise: Promise<unknown>, ms: number): Promise<"settled" | "timeout"> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise.then(() => "settled" as const),
			new Promise<"timeout">((resolve) => {
				timer = setTimeout(resolve, ms, "timeout");
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
export async function drained(
	drain: Iterable<Promise<unknown>>,
	size: number,
	ms: number,
): Promise<"settled" | "timeout"> {
	return size ? within(Promise.allSettled(drain), ms) : "settled";
}
