import { awaitWithContext, type Context, withAbortSignal, withoutAbortSignal } from "../context/index.ts";
import { ObjectsError, type Principal } from "../data/index.ts";
import { CallContext, type Acquirer, type Ctx } from "./ctx.ts";
import type { SpanAttributes } from "@axi/telemetry";

export type RootOptions<P extends Principal = Principal> = {
	readonly principal?: P | undefined;
	readonly trace?: { readonly name: string; readonly attributes?: SpanAttributes };
};
type RootHost = Acquirer & { readonly incarnation: string };
type OpenScope = {
	seal(reason: unknown): void;
	readonly close: (reason: unknown) => void;
};
const settled = new ObjectsError({
	code: "released",
	reason: "settled",
	message: "host.root: its fn settled",
});

export class RootScopes {
	readonly #host: RootHost;
	readonly #scopes = new Set<OpenScope>();
	constructor(host: RootHost) {
		this.#host = host;
	}
	run<T>(fn: (context: Ctx) => Promise<T>, principal: Principal | undefined, context: Context): Promise<T> {
		const signal = context.abortSignal;
		signal?.throwIfAborted();
		const controller = new AbortController();
		const owned = withAbortSignal(controller.signal, signal ? withoutAbortSignal(context) : context);
		const ctx = new CallContext(owned, { principal, incarnation: this.#host.incarnation }, this.#host);
		const result = Promise.withResolvers<T>();
		const scope: OpenScope = {
			close: result.reject,
			seal: (reason) => {
				if (!this.#scopes.delete(scope)) return;
				signal?.removeEventListener("abort", abort);
				ctx.settle();
				controller.abort(reason);
			},
		};
		const abort = (): void => scope.seal(signal?.reason);
		this.#scopes.add(scope);
		signal?.addEventListener("abort", abort, { once: true });
		(async () => fn(ctx))().then(
			(value) => {
				scope.seal(settled);
				result.resolve(value);
			},
			(error) => {
				scope.seal(settled);
				result.reject(error);
			},
		);
		return signal ? awaitWithContext(result.promise, context) : result.promise;
	}

	close(reason: unknown): void {
		for (const scope of [...this.#scopes]) {
			scope.seal(reason);
			scope.close(reason);
		}
	}
}
