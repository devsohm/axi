import { NOOP_TELEMETRY_CONTEXT, type SpanAttributes, type TelemetrySpan } from "@axi/telemetry";
import { withAbortSignal, withoutAbortSignal, withTelemetry, type Context, type ContextKey } from "../context/index.ts";
import { CALL_CHAIN, type CallNode, type OldWorkSource } from "./old-work.ts";
import type { Contract, ParamsOf } from "../contracts/index.ts";
import { isObjectsError, ObjectsError, type Principal } from "../data/index.ts";
import type { Binding, Reference } from "./reference.ts";

export type GetOptions = { readonly readyTimeout?: number };
export type Caller = {
	readonly principal: Principal | undefined;
	readonly incarnation: string;
};
export interface Ctx<P extends Principal = Principal> extends Context {
	readonly principal: P | undefined;
	readonly incarnation: string;
	get<C extends Contract>(type: C, params: ParamsOf<C>, options?: GetOptions): Promise<Reference<C>>;
	trace<T>(name: string, attributes: SpanAttributes, fn: (ctx: Ctx<P>) => Promise<T>): Promise<T>;
}
export type Acquirer = {
	readonly spanHost: string;
	acquire(
		type: Contract,
		params: ParamsOf<Contract>,
		caller: Caller,
		context: Context,
		options: GetOptions,
	): Promise<Binding>;
};

export function withLinkedAbortSignal(
	signal: AbortSignal,
	context: Context,
): { readonly context: Context; release(): void } {
	const callerSignal = context.abortSignal;
	const sources = callerSignal === undefined ? [signal] : [callerSignal, signal];
	if (sources.length === 1) return { context: withAbortSignal(signal, context), release() {} };
	const controller = new AbortController();
	const listeners = sources.map((source) => {
		const listener = (): void => {
			release();
			controller.abort(source.reason);
		};
		return { source, listener };
	});
	const release = (): void => {
		for (const { source, listener } of listeners) source.removeEventListener("abort", listener);
	};
	const aborted = sources.find((source) => source.aborted);
	if (aborted) controller.abort(aborted.reason);
	else for (const { source, listener } of listeners) source.addEventListener("abort", listener, { once: true });
	return {
		context: withAbortSignal(controller.signal, withoutAbortSignal(context)),
		release,
	};
}

export class CallContext implements Ctx, CallNode {
	readonly principal: Principal | undefined;
	readonly incarnation: string;
	readonly #context: Context;
	readonly #host: Acquirer;
	readonly #on: OldWorkSource | undefined;
	#bindings: Binding[] | undefined = [];
	#ending: AbortController | undefined;
	constructor(context: Context, caller: Caller, host: Acquirer, on?: OldWorkSource) {
		this.#context = context;
		this.#on = on;
		this.#host = host;
		this.principal = caller.principal;
		this.incarnation = caller.incarnation;
	}
	get abortSignal(): AbortSignal | undefined {
		return this.#context.abortSignal;
	}
	get telemetry(): Context["telemetry"] {
		return this.#context.telemetry;
	}
	value<T>(key: ContextKey<T>): T | undefined {
		// This key carries a call node only when the scope runs a method.
		if (key.token === CALL_CHAIN.token && this.#on !== undefined) return this as unknown as T;
		return this.#context.value(key);
	}
	get on(): OldWorkSource {
		return this.#on!;
	}
	up(): CallNode | undefined {
		return this.#context.value(CALL_CHAIN);
	}
	toString(): string {
		return `${this.#context}.Ctx`;
	}
	get spanHost(): string {
		return this.#host.spanHost;
	}
	trace<T>(name: string, attributes: SpanAttributes, fn: (ctx: Ctx) => Promise<T>): Promise<T> {
		return traceScope(this, name, attributes, fn);
	}
	traced(span: TelemetrySpan): Ctx {
		return new SpanCtx(this, span);
	}
	async get<C extends Contract>(type: C, params: ParamsOf<C>, options: GetOptions = {}): Promise<Reference<C>> {
		const ended = (): ObjectsError =>
			new ObjectsError({
				code: "released",
				reason: "settled",
				message: `${type.name}: ctx.get after its call settled`,
			});
		if (this.#bindings === undefined) throw ended();
		this.abortSignal?.throwIfAborted();
		this.#ending ??= new AbortController();
		const linked = withLinkedAbortSignal(this.#ending.signal, this);
		let binding: Binding;
		try {
			binding = await this.#host.acquire(
				type,
				params,
				{ principal: this.principal, incarnation: this.incarnation },
				linked.context,
				options,
			);
		} catch (error) {
			throw this.#bindings === undefined ? ended() : error;
		} finally {
			linked.release();
		}
		if (this.#bindings === undefined) {
			binding.release();
			throw ended();
		}
		this.#bindings.push(binding);
		return binding.reference as Reference<C>;
	}
	settle(): void {
		const bindings = this.#bindings;
		this.#bindings = undefined;
		this.#ending?.abort();
		for (const binding of bindings ?? []) binding.release();
	}
}

type TraceScope = Ctx & { readonly spanHost: string; traced(span: TelemetrySpan): Ctx };
async function traceScope<T>(
	scope: TraceScope,
	name: string,
	attributes: SpanAttributes,
	fn: (ctx: Ctx) => Promise<T>,
): Promise<T> {
	if (scope.telemetry.startSpan === NOOP_TELEMETRY_CONTEXT.startSpan) return fn(scope);
	return scope.telemetry.startSpan(
		{ name, attributes: { "objects.host": scope.spanHost, ...attributes } },
		async (span) => {
			try {
				return await fn(scope.traced(span));
			} catch (error) {
				span.setStatus(
					scope.abortSignal?.aborted || isObjectsError(error, "aborted")
						? { status: "ok" }
						: {
								status: "error",
								error: {
									name: "trace_failed",
									message: (error instanceof Error ? error.message : String(error)).slice(0, 500),
								},
							},
				);
				throw error;
			}
		},
	);
}
export class SpanCtx implements TraceScope {
	readonly #parent: TraceScope;
	readonly #context: Context;
	constructor(parent: TraceScope, span: TelemetrySpan) {
		this.#parent = parent;
		this.#context = withTelemetry(span, parent);
	}
	get spanHost(): string {
		return this.#parent.spanHost;
	}
	get principal(): Principal | undefined {
		return this.#parent.principal;
	}
	get incarnation(): string {
		return this.#parent.incarnation;
	}
	get abortSignal(): AbortSignal | undefined {
		return this.#parent.abortSignal;
	}
	get telemetry(): TelemetrySpan {
		return this.#context.telemetry;
	}
	value<T>(key: ContextKey<T>): T | undefined {
		return this.#context.value(key);
	}
	toString(): string {
		return `${this.#parent}.Trace`;
	}
	get<C extends Contract>(type: C, params: ParamsOf<C>, options?: GetOptions): Promise<Reference<C>> {
		return this.#parent.get(type, params, options);
	}
	trace<T>(name: string, attributes: SpanAttributes, fn: (ctx: Ctx) => Promise<T>): Promise<T> {
		return traceScope(this, name, attributes, fn);
	}
	traced(span: TelemetrySpan): Ctx {
		return new SpanCtx(this, span);
	}
}
