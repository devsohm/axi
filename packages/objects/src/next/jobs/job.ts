import type { JobDefinition } from "./definition.ts";
import { withAbortSignal, withoutAbortSignal, type Context } from "../../context/index.ts";
import type { Draft } from "../../delta/index.ts";
import type { JsonValue } from "../../json.ts";
import type { Watchable } from "../../watch.ts";
import { ObjectsError, isObjectsError, PluginError, type Principal } from "../data/index.ts";
import type { CommitPersistence, JsonObject, Tx } from "../documents/index.ts";
import type { Documents, SealToken, Transaction } from "../documents/internal.ts";
import { CallContext, type Acquirer, type Caller, type Ctx } from "../host/ctx.ts";
import { nextDelay } from "../host/backoff.ts";
import { sleep } from "../host/sleep.ts";
import type { Outcome } from "./definition.ts";
import type { JobRecords, Settled } from "./records.ts";
import type { AnyOutcome, Invocation, JobRun, Run } from "./run.ts";
import type { RunningEntry } from "./running.ts";

export type StartOptions = { readonly key?: string };
export interface JobHandle<A, R, S> {
	start(args: A, context: Context, options?: StartOptions): Promise<Run<Outcome<A, R, S>>>;
	outcome(id: string, context: Context): Promise<Outcome<A, R, S>>;
	abort(id: string, context: Context): Promise<"marked" | "terminal">;
	readonly running: Watchable<readonly RunningEntry<A, S>[]>;
}
export interface RunState<S> {
	readonly value: S;
	change<T>(
		fn: (draft: Draft<S>) => T,
		context: Context,
		options?: { readonly persistence?: CommitPersistence },
	): Promise<T>;
}
export type JobImplementation<A, R, S, P extends Principal = Principal> = {
	readonly run: (args: A, context: JobCtx<P, S>) => Promise<R>;
	readonly finish?: (outcome: Outcome<A, R, S>, tx: Tx) => void | Promise<void>;
};
export type JobCtx<P extends Principal, S> = Ctx<P> & {
	readonly jobId: string;
} & ([S] extends [undefined] ? unknown : { readonly state: RunState<S> });
export type AnyJobImplementation = {
	readonly run: (args: JsonValue, ctx: JobContext) => Promise<unknown>;
	readonly finish?: (outcome: AnyOutcome, tx: Tx) => void | Promise<void>;
};
export type JobOwner = {
	readonly host: Acquirer;
	readonly caller: Caller;
	readonly context: Context;
	readonly signal: AbortSignal;
	readonly token: SealToken;
	readonly documents: Documents;
	admit(running: Promise<unknown>, cleanup?: () => void): void;
	admitRun(running: Promise<unknown>, cleanup: () => void): void;
};

export class Job implements JobHandle<JsonValue, unknown, JsonValue | undefined> {
	readonly #records: JobRecords;
	readonly #definition: JobDefinition<unknown, unknown, unknown>;
	#handed = false;
	#cutReason: "restart" | "reload" = "restart";
	readonly #implementation: AnyJobImplementation;
	readonly #owner: JobOwner;
	#phase: "declared" | "live" | "handed" | "sealed" = "declared";
	#sealError: ObjectsError | undefined;
	readonly #invocations = new Set<JobRun>();
	readonly #finishing = new Set<JobRun>();
	constructor(records: JobRecords, implementation: AnyJobImplementation, owner: JobOwner) {
		this.#records = records;
		this.#definition = records.definition;
		this.#implementation = implementation;
		this.#owner = owner;
	}
	get running(): Watchable<readonly RunningEntry<JsonValue, JsonValue | undefined>[]> {
		return this.#records.running as unknown as Watchable<readonly RunningEntry<JsonValue, JsonValue | undefined>[]>;
	}
	start(args: JsonValue, context: Context, options: StartOptions = {}): Promise<Run<AnyOutcome>> {
		return this.#owner.documents.tx((tx) => this.stage(tx, args, context, options), this.#owner.token, context);
	}
	outcome(id: string, context: Context): Promise<AnyOutcome> {
		return this.#records.outcome(id, context);
	}
	abort(id: string, context: Context): Promise<"marked" | "terminal"> {
		return this.#records.abort(id, context);
	}
	load(context: Context): Promise<void> {
		return this.#records.load(context);
	}
	writeAtClose(context: Context): Promise<void> {
		return this.#records.writeAtClose(context);
	}
	live(): void {
		if (this.#phase === "declared") {
			this.#phase = "live";
			this.#records.attach(this);
		}
	}
	stage(tx: Transaction, args: unknown, context: Context, options: StartOptions): Run<AnyOutcome> {
		if (tx.documents !== this.#owner.documents)
			throw new Error(`${this.#owner.documents.label}: a transaction starts only its own object's jobs`);
		if (this.#phase === "sealed" || this.#phase === "handed")
			throw new ObjectsError({
				code: "released",
				reason: "ended",
				message: `${this.#records.name}: its attempt ended`,
			});
		if (this.#phase === "declared")
			throw new ObjectsError({
				code: "not_ready",
				message: `${this.#records.name}: its object is not live yet`,
			});
		return this.#records.stage(tx, args, context, options);
	}
	handOver(): void {
		if (this.#phase === "sealed" || this.#phase === "handed") return;
		this.#phase = "handed";
		this.#handed = true;
		this.#records.detach(this, []);
	}
	seal(error: ObjectsError, reason: "restart" | "reload" = "restart"): void {
		if (this.#phase === "sealed") return;
		const handed = this.#phase === "handed";
		this.#phase = "sealed";
		this.#sealError = error;
		this.#cutReason = reason;
		this.#records.detach(this, this.#finishing);
		this.#finishing.clear();
		if (!handed) for (const run of this.#invocations) this.#records.cut(run, error, reason);
		this.#invocations.clear();
	}
	invoke(run: JobRun): void {
		const invocation = run.begin();
		if (!this.#records.persisted || run.phase === "running") {
			this.#execute(run, invocation);
			return;
		}
		const owner = this.#owner;
		const reservation = owner.documents
			.tx((tx) => this.#records.reserve(tx, run), owner.token, owner.context)
			.then(
				() => {
					if (this.#phase !== "sealed" || this.#handed) this.#execute(run, invocation);
					else {
						this.#records.cut(run, this.#sealError!, this.#cutReason);
						invocation.ended();
					}
				},
				() => {
					invocation.settle();
					invocation.ended();
					if (this.#phase === "sealed") this.#records.requeue(run);
				},
			);
		owner.admit(reservation);
	}
	finish(run: JobRun): void {
		this.#owner.admit(this.#finish(run));
	}
	#execute(run: JobRun, invocation: Invocation): void {
		const owner = this.#owner,
			ctx = new JobContext(
				withAbortSignal(invocation.abort.signal, owner.context),
				owner.caller,
				owner.host,
				run.id,
				this.#state(run, invocation),
			);
		const complete = Promise.withResolvers<void>();
		owner.admitRun(complete.promise, () => ctx.settle());
		this.#invocations.add(run);
		const execute = async (): Promise<unknown> => {
			try {
				return await this.#implementation.run(this.#records.argsOf(run, this.#definition), ctx);
			} finally {
				invocation.settle();
			}
		};
		execute()
			.then(
				(result) => this.#settled(run, invocation, ctx, { kind: "done", result }),
				(error: unknown) => {
					let settled: Settled;
					if (invocation.abort.signal.aborted)
						settled = {
							kind: "failed",
							error: { kind: "aborted", reason: "abort" },
						};
					else {
						this.#records.report({ kind: "job_failed", id: run.id, error });
						const failure =
							isObjectsError(error) || error instanceof PluginError
								? error
								: new PluginError("internal", error instanceof Error ? error.message : String(error));
						settled = {
							kind: "failed",
							error: { kind: "threw", error: failure },
						};
					}
					this.#settled(run, invocation, ctx, settled);
				},
			)
			.finally(() => invocation.ended())
			.then(complete.resolve);
	}
	#settled(run: JobRun, invocation: Invocation, ctx: JobContext, settled: Settled): void {
		ctx.settle();
		if (invocation.token.sealed || run.invocation !== invocation) return;
		this.#invocations.delete(run);
		this.#records.settled(run, settled);
	}
	async #finish(run: JobRun): Promise<void> {
		const owner = this.#owner;
		this.#finishing.add(run);
		let delay: number | undefined;
		try {
			while (true) {
				try {
					return await owner.documents.tx(
						async (tx) => {
							this.#records.staging(tx).finishing = run;
							await this.#implementation.finish?.(this.#records.outcomeOf(run, owner.context), tx);
							this.#records.change(tx, { kind: "delete", run });
						},
						owner.token,
						owner.context,
					);
				} catch (error) {
					if (this.#phase === "sealed") return;
					this.#records.report({
						kind: "job_finish_failed",
						id: run.id,
						error,
					});
					const finishFailures = run.finishFailures + 1;
					if (finishFailures >= 5)
						return this.#records.record(run, {
							kind: "block",
							run,
							reason: "finish_failed",
						});
					await this.#records.record(run, {
						kind: "update",
						run,
						fields: { finishFailures },
					});
					delay = nextDelay(delay);
					try {
						await sleep(delay, withAbortSignal(owner.signal, owner.context));
					} catch {
						return;
					}
				}
			}
		} finally {
			this.#finishing.delete(run);
		}
	}
	#state(run: JobRun, invocation: Invocation): RunState<JsonObject> | undefined {
		const records = this.#records,
			states = records.states;
		if (!states) return undefined;
		const refused = (): ObjectsError =>
			new ObjectsError({
				code: "released",
				reason: "settled",
				message: `${records.name}: run ${run.id} settled; its state is closed`,
			});
		return {
			get value() {
				const value = records.stateOf(run.id);
				if (value === undefined) throw refused();
				return value;
			},
			change: <T>(
				fn: (draft: Draft<JsonObject>) => T,
				context: Context,
				options: { readonly persistence?: CommitPersistence } = {},
			): Promise<T> => {
				if (invocation.state !== "running") return Promise.reject(refused());
				let persistence: CommitPersistence;
				try {
					const input = options.persistence;
					if (input === undefined || input.kind === "immediate") persistence = { kind: "immediate" };
					else if (
						input.kind === "deferred" &&
						(input.withinMs === undefined || (typeof input.withinMs === "number" && input.withinMs >= 0))
					)
						persistence = input;
					else
						throw new ObjectsError({
							code: "invalid",
							reason: "args",
							message: `${records.name}: persistence is immediate or deferred with withinMs >= 0`,
						});
				} catch (error) {
					return Promise.reject(error);
				}
				if (run.restarts) persistence = { kind: "immediate" };
				return this.#owner.documents.tx(
					async (tx) => {
						const result = fn(await tx.draftSlot(states, run.id));
						records.progressed(tx, run);
						return result;
					},
					invocation.token,
					withoutAbortSignal(context),
					persistence,
				);
			},
		};
	}
}

export class JobContext extends CallContext {
	readonly jobId: string;
	declare readonly state: RunState<JsonObject> | undefined;
	constructor(
		context: Context,
		caller: Caller,
		host: Acquirer,
		jobId: string,
		state: RunState<JsonObject> | undefined,
	) {
		super(context, caller, host);
		this.jobId = jobId;
		if (state !== undefined) this.state = state;
	}
}
