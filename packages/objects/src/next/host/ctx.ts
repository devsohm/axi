import { withAbortSignal, withoutAbortSignal, type Context, type ContextKey } from "../../context/index.ts";
import type { Contract, ParamsOf } from "../contracts/index.ts";
import { ObjectsError, type Principal } from "../data/index.ts";
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
}
export type Acquirer = {
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
	const sources = context.abortSignal === undefined ? [signal] : [context.abortSignal, signal];
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

export class CallContext implements Ctx {
	readonly principal: Principal | undefined;
	readonly incarnation: string;
	readonly #context: Context;
	readonly #host: Acquirer;
	#bindings: Binding[] | undefined = [];
	#ending: AbortController | undefined;
	constructor(context: Context, caller: Caller, host: Acquirer) {
		this.#context = context;
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
		return this.#context.value(key);
	}
	toString(): string {
		return `${this.#context}.Ctx`;
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
		const linked = withLinkedAbortSignal(this.#ending.signal, this.#context);
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
