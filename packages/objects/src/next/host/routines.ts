import type { Context } from "../../context/index.ts";
import { PendingOps, type Op } from "../../delta/index.ts";
import type { JsonValue } from "../../json.ts";
import {
	NativeWatch,
	type NativeWatchable,
	type NativeWatchCall,
	type Watchable,
	type WatchCall,
	type WatchEnd,
} from "../../watch.ts";
import type { Principal } from "../data/index.ts";
import { NativeSource, Source } from "../state/internal.ts";
import { nextDelay } from "./backoff.ts";
import { CallContext, type Acquirer, type Caller, type Ctx } from "./ctx.ts";
import { resolveWatchable } from "./reference.ts";
import type { HostError, Position } from "./report.ts";
import { sleep } from "./sleep.ts";

export type WatchValueCall<T> = Extract<WatchCall<T>, { readonly kind: "value" }>;
export type NativeWatchValueCall<T> = Extract<NativeWatchCall<T>, { readonly kind: "value" }>;
export type OnHandler<T, C extends Ctx = Ctx> = (call: WatchValueCall<T>, ctx: C) => void | Promise<void>;
export type OnNativeHandler<T, C extends Ctx = Ctx> = (call: NativeWatchValueCall<T>, ctx: C) => void | Promise<void>;
export type OnLiveHandler<C extends Ctx = Ctx> = (ctx: C) => void | Promise<void>;
export interface RoutineDeclarations<P extends Principal = Principal> {
	on<T>(source: Watchable<T>, fn: OnHandler<T, Ctx<P>>): void;
	on<T>(source: NativeWatchable<T>, fn: OnNativeHandler<T, Ctx<P>>): void;
	onLive(fn: OnLiveHandler<Ctx<P>>): void;
}
export type RoutineOwner = {
	readonly label: string;
	readonly host: Acquirer & { report(error: HostError): void };
	readonly caller: Caller;
	readonly context: Context;
	admit(running: Promise<unknown>, cleanup: () => void): void;
};
type Declaration =
	| {
			readonly kind: "on";
			readonly at: Position;
			readonly source: Watchable<unknown> | NativeWatchable<unknown>;
			readonly fn: (...args: never[]) => void | Promise<void>;
	  }
	| {
			readonly kind: "onLive";
			readonly at: Position;
			readonly fn: OnLiveHandler;
	  };
type Result = { readonly kind: "done" } | { readonly kind: "failed"; readonly error: unknown };

function invoke(owner: RoutineOwner, fn: (context: Ctx) => void | Promise<void>): Promise<Result> {
	const ctx = new CallContext(owner.context, owner.caller, owner.host),
		finished = Promise.withResolvers<Result>();
	owner.admit(finished.promise, () => ctx.settle());
	const settle = (result: Result): void => {
		ctx.settle();
		finished.resolve(result);
	};
	(async () => fn(ctx))().then(
		() => settle({ kind: "done" }),
		(error: unknown) => settle({ kind: "failed", error }),
	);
	return finished.promise;
}
function report(owner: RoutineOwner, routine: Position, error: unknown): void {
	owner.host.report({
		kind: "routine_failed",
		object: owner.label,
		routine,
		error,
	});
}

export class Routines {
	readonly #declarations: Declaration[] = [];
	#ons = 0;
	#lives = 0;
	on(source: Watchable<unknown> | NativeWatchable<unknown>, fn: (...args: never[]) => void | Promise<void>): void {
		this.#declarations.push({
			kind: "on",
			at: { kind: "on", position: ++this.#ons },
			source,
			fn,
		});
	}
	onLive(fn: OnLiveHandler): void {
		this.#declarations.push({
			kind: "onLive",
			at: { kind: "onLive", position: ++this.#lives },
			fn,
		});
	}
	start(owner: RoutineOwner): void {
		for (const declaration of this.#declarations) {
			if (owner.context.abortSignal?.aborted) return;
			if (declaration.kind === "on") void new SourceRoutine(owner, declaration).start();
			else void this.#live(owner, declaration);
		}
	}
	async #live(owner: RoutineOwner, declaration: Extract<Declaration, { readonly kind: "onLive" }>): Promise<void> {
		let delay: number | undefined;
		while (!owner.context.abortSignal?.aborted) {
			const start = Date.now(),
				result = await invoke(owner, declaration.fn);
			if (result.kind === "done" || owner.context.abortSignal?.aborted) return;
			report(owner, declaration.at, result.error);
			delay = nextDelay(Date.now() - start >= 60_000 ? undefined : delay);
			try {
				await sleep(delay, owner.context);
			} catch {
				return;
			}
		}
	}
}
type Phase =
	| { readonly kind: "starting" | "idle" | "calling" | "ended" }
	| {
			readonly kind: "settling" | "backoff";
			readonly timer: ReturnType<typeof setTimeout>;
	  };
type Failing = { readonly kind: "failed" } | { readonly kind: "empty"; readonly source: Source };

class SourceRoutine {
	readonly #owner: RoutineOwner;
	readonly #declaration: Extract<Declaration, { readonly kind: "on" }>;
	#phase: Phase = { kind: "starting" };
	#native = false;
	#pending: { readonly value: unknown } | undefined;
	readonly #ops = new PendingOps();
	#retired = false;
	#full = true;
	#failed = false;
	#last: unknown;
	#lastRetired = false;
	#delay: number | undefined;
	constructor(owner: RoutineOwner, declaration: Extract<Declaration, { readonly kind: "on" }>) {
		this.#owner = owner;
		this.#declaration = declaration;
	}
	async start(): Promise<void> {
		let failing = this.#failing();
		while (failing?.kind === "empty") {
			if (!(await this.#first(failing.source))) {
				this.#phase = { kind: "ended" };
				return;
			}
			failing = this.#failing();
		}
		let watch: Awaited<ReturnType<Extract<Declaration, { readonly kind: "on" }>["source"]["watch"]>>;
		try {
			watch = await this.#declaration.source.watch(this.#owner.context);
		} catch (error) {
			this.#phase = { kind: "ended" };
			if (!this.#aborted()) report(this.#owner, this.#declaration.at, error);
			return;
		}
		this.#native = watch instanceof NativeWatch;
		void watch.closed.then((end) => this.#end(end));
		try {
			watch.start((call: WatchCall<unknown> | NativeWatchCall<unknown>) => {
				if (call.kind === "value") this.#frame(call);
				else this.#failure();
				return Promise.resolve();
			});
		} catch {
			return;
		}
		if (failing?.kind === "failed") {
			this.#phase = { kind: "idle" };
			return;
		}
		this.#pending = { value: watch.value };
		this.#next();
	}
	#failing(): Failing | undefined {
		const declared = this.#declaration.source;
		if (declared instanceof NativeSource) return declared.start().kind === "failed" ? { kind: "failed" } : undefined;
		try {
			const source = resolveWatchable(declared);
			if (!(source instanceof Source)) return undefined;
			const start = source.start();
			return start.kind === "value"
				? undefined
				: start.last === undefined
					? { kind: "empty", source }
					: { kind: "failed" };
		} catch {
			return undefined;
		}
	}
	#first(source: Source): Promise<boolean> {
		const signal = this.#owner.context.abortSignal;
		return new Promise((resolve) => {
			const done = (found: boolean): void => {
				source.unsubscribe(listener);
				signal?.removeEventListener("abort", abort);
				resolve(found);
			};
			const listener = {
				advance(call: WatchCall<JsonValue>) {
					if (call.kind === "value") done(true);
				},
				end() {
					done(false);
				},
				endAfterDelivery() {
					done(false);
				},
			};
			const abort = (): void => done(false);
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) abort();
			else source.subscribe(listener);
		});
	}
	#failure(): void {
		if (this.#phase.kind === "ended") return;
		this.#failed = true;
		this.#pending = undefined;
		this.#ops.take();
		this.#full = true;
		if (this.#phase.kind === "backoff" || this.#phase.kind === "settling") {
			clearTimeout(this.#phase.timer);
			this.#phase = { kind: "idle" };
		}
	}
	#frame(call: WatchValueCall<unknown> | NativeWatchValueCall<unknown>): void {
		const phase = this.#phase;
		if (phase.kind === "ended") return;
		this.#failed = false;
		this.#pending = { value: call.value };
		if ("ops" in call) {
			this.#ops.push(call.ops);
			this.#retired ||= call.retired;
		}
		if (phase.kind === "backoff") clearTimeout(phase.timer);
		if (phase.kind === "backoff" || phase.kind === "idle") this.#next();
	}
	#next(): void {
		const pending = this.#pending;
		if (!pending || this.#aborted()) {
			this.#phase = { kind: "idle" };
			return;
		}
		this.#pending = undefined;
		this.#phase = { kind: "calling" };
		this.#last = pending.value;
		let call: WatchValueCall<unknown> | NativeWatchValueCall<unknown> = {
			kind: "value",
			value: pending.value,
		};
		if (!this.#native) {
			const ops = this.#ops.take();
			const changes: readonly Op[] =
				this.#full || ops.kind === "replace" ? [["r", pending.value as JsonValue]] : ops.ops;
			call = { ...call, ops: changes, retired: this.#retired };
			this.#lastRetired = this.#retired;
			this.#retired = false;
		}
		const fn = this.#declaration.fn as OnHandler<unknown> | OnNativeHandler<unknown>;
		void invoke(this.#owner, (ctx) => fn(call as WatchValueCall<unknown>, ctx)).then((result) => this.#settled(result));
	}
	#settled(result: Result): void {
		if (this.#phase.kind === "ended") return;
		if (result.kind === "done") {
			this.#full = false;
			this.#delay = undefined;
			this.#phase = this.#pending ? { kind: "settling", timer: setTimeout(() => this.#next(), 0) } : { kind: "idle" };
			return;
		}
		if (this.#aborted()) return;
		report(this.#owner, this.#declaration.at, result.error);
		this.#full = true;
		this.#retired ||= this.#lastRetired;
		this.#delay = nextDelay(this.#delay);
		if (this.#failed) {
			this.#phase = { kind: "idle" };
			return;
		}
		this.#phase = {
			kind: "backoff",
			timer: setTimeout(() => {
				this.#pending ??= { value: this.#last };
				this.#next();
			}, this.#delay),
		};
	}
	#end(end: WatchEnd): void {
		if (this.#phase.kind === "settling" || this.#phase.kind === "backoff") clearTimeout(this.#phase.timer);
		this.#phase = { kind: "ended" };
		this.#pending = undefined;
		this.#ops.take();
		this.#retired = false;
		if (end.kind === "failed" && !this.#aborted()) report(this.#owner, this.#declaration.at, end.error);
	}
	#aborted(): boolean {
		return this.#owner.context.abortSignal?.aborted === true;
	}
}
