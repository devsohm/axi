import { withAbortSignal, type Context } from "../context/index.ts";
import { asObjectsError, checkParams, waitingFor } from "../data/internal.ts";
import type { FailureCause } from "../data/index.ts";
import type { Caller } from "./ctx.ts";
import type { AttemptHost } from "./attempt.ts";
import type { Binding } from "./reference.ts";
import type { Request } from "./staging.ts";

export class Readiness {
	readonly host: AttemptHost;
	readonly caller: Caller;
	readonly requests: readonly Request[];
	readonly show: (failure: FailureCause | undefined) => void;
	readonly context: Context;
	readonly #bindings: Binding[] = [];
	readonly #started = Promise.withResolvers<void>();
	readonly #cancel = new AbortController();
	readonly #following: Context;
	#refusal: FailureCause | undefined;
	#failure: { readonly from: FailureCause; readonly waiting: FailureCause } | undefined;
	constructor(
		host: AttemptHost,
		caller: Caller,
		requests: readonly Request[],
		show: (failure: FailureCause | undefined) => void,
		context: Context,
	) {
		this.host = host;
		this.caller = caller;
		this.requests = requests;
		this.show = show;
		this.context = context;
		this.#following = withAbortSignal(this.#cancel.signal, context);
	}
	get cause(): FailureCause | undefined {
		return this.#refusal ?? this.#failure?.waiting;
	}
	start(): void {
		for (const request of this.requests) {
			if (request.kind !== "type") continue;
			const binding = this.host.reference(request.contract, undefined, this.caller, {});
			binding.unlist();
			this.#bindings.push(binding);
			try {
				this.host.bind(
					binding,
					request.contract,
					checkParams(request.contract, request.params, this.context),
					this.context,
				);
			} catch (error) {
				this.#refusal ??= { kind: "broken", error: asObjectsError(error, request.contract.name) };
				continue;
			}
			void binding
				.until(() => {
					this.#changed();
					return false;
				}, this.#following)
				.catch(() => {});
		}
		this.#changed();
		this.#started.resolve();
	}
	async ready(due: number): Promise<void> {
		const expiry = Promise.withResolvers<void>();
		const timer = setTimeout(expiry.resolve, Math.max(0, due - Date.now()));
		try {
			await Promise.race([
				expiry.promise,
				this.#started.promise.then(() =>
					Promise.all(
						this.#bindings.map((binding) => binding.until(() => ready(binding), this.#following).catch(() => {})),
					),
				),
			]);
		} finally {
			clearTimeout(timer);
		}
	}
	release(): void {
		this.#cancel.abort();
		for (const binding of this.#bindings.splice(0)) binding.release();
	}
	#changed(): void {
		const before = this.cause;
		const failed = this.#bindings.find((binding) => binding.refState.kind === "failed" && !versionSkew(binding));
		const state = failed?.refState;
		const from = state?.kind === "failed" ? state.cause : undefined;
		if (from !== this.#failure?.from)
			this.#failure = from && failed ? { from, waiting: waitingFor(failed.label, from.error) } : undefined;
		if (before !== this.cause) this.show(this.cause);
	}
}
function versionSkew(binding: Binding): boolean {
	const state = binding.refState;
	if (state.kind !== "failed" || binding.target?.kind !== "remote") return false;
	const { code, reason } = state.cause.error;
	return code === "contract_mismatch" || (code === "unavailable" && reason === "version");
}
function ready(binding: Binding): boolean {
	return binding.refState.kind === "failed" ? !versionSkew(binding) : binding.refState.kind !== "loading";
}
