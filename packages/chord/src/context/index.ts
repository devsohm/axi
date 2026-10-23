import { NOOP_TELEMETRY_CONTEXT, type SpanOptions, type TelemetrySpan } from "@axi/telemetry";

export interface ContextKey<T> {
	readonly token: symbol;
	readonly valueType?: (value: T) => T;
}

export interface Context {
	readonly abortSignal: AbortSignal | undefined;
	readonly telemetry: TelemetrySpan;
	value<T>(key: ContextKey<T>): T | undefined;
	toString(): string;
}

export function createContextKey<T>(description: string): ContextKey<T> {
	return Object.freeze({ token: Symbol(description) });
}

const cancellation = createContextKey<AbortSignal | undefined>("chord.abortSignal");
const tracing = createContextKey<TelemetrySpan>("chord.telemetry");

abstract class ContextBase implements Context {
	abstract value<T>(key: ContextKey<T>): T | undefined;
	abstract toString(): string;
	get abortSignal(): AbortSignal | undefined {
		return this.value(cancellation);
	}
	get telemetry(): TelemetrySpan {
		return this.value(tracing) ?? NOOP_TELEMETRY_CONTEXT;
	}
}

class EmptyContext extends ContextBase {
	readonly #label: string;
	constructor(label: string) {
		super();
		this.#label = label;
	}
	value<T>(_key: ContextKey<T>): T | undefined {
		return undefined;
	}
	toString(): string {
		return this.#label;
	}
}

class ValueContext<T> extends ContextBase {
	readonly #parent: Context;
	readonly #key: ContextKey<T>;
	readonly #stored: T;
	constructor(parent: Context, key: ContextKey<T>, stored: T) {
		super();
		this.#parent = parent;
		this.#key = key;
		this.#stored = stored;
	}
	value<Value>(requested: ContextKey<Value>): Value | undefined {
		return requested.token === this.#key.token ? (this.#stored as unknown as Value) : this.#parent.value(requested);
	}
	toString(): string {
		return `${this.#parent}.WithValue(${this.#key.token.description ?? "anonymous"})`;
	}
}

export const BACKGROUND_CONTEXT: Context = new EmptyContext("[Context BACKGROUND_CONTEXT]");
export const TODO_CONTEXT: Context = new EmptyContext("[Context TODO_CONTEXT]");

export function withContextValue<T>(key: ContextKey<T>, stored: T, parent: Context): Context {
	return new ValueContext(parent, key, stored);
}

export function withTelemetry<T extends TelemetrySpan>(
	telemetry: T,
	context: Context,
): Context & { readonly telemetry: T } {
	return withContextValue(tracing, telemetry, context) as Context & { readonly telemetry: T };
}

export function traceIn<T>(
	options: SpanOptions,
	fn: (context: Context) => T | Promise<T>,
	context: Context,
): Promise<T> {
	return context.telemetry.startSpan(options, (span) => fn(withTelemetry(span, context)));
}

export function withAbortSignal(signal: AbortSignal, parent: Context): Context {
	const inherited = parent.abortSignal;
	return withContextValue(
		cancellation,
		inherited === undefined ? signal : AbortSignal.any([inherited, signal]),
		parent,
	);
}

export function withoutAbortSignal(parent: Context): Context {
	return withContextValue(cancellation, undefined, parent);
}

export function withCancel(parent: Context): {
	readonly context: Context;
	readonly cancel: (reason?: unknown) => void;
} {
	const controller = new AbortController();
	return { context: withAbortSignal(controller.signal, parent), cancel: (reason) => controller.abort(reason) };
}

function cancellationError(signal: AbortSignal): Error {
	const reason: unknown = signal.reason;
	return reason instanceof Error ? reason : new DOMException("The operation was aborted", "AbortError");
}

export function awaitWithContext<T>(work: Promise<T>, context: Context): Promise<T> {
	const signal = context.abortSignal;
	if (signal === undefined) return work;
	if (signal.aborted) return Promise.reject(cancellationError(signal));
	return new Promise<T>((resolve, reject) => {
		const aborted = () => reject(cancellationError(signal));
		signal.addEventListener("abort", aborted, { once: true });
		void work.then(
			(result) => {
				signal.removeEventListener("abort", aborted);
				resolve(result);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", aborted);
				reject(error);
			},
		);
	});
}
