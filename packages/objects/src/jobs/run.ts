import type { Context } from "../context/index.ts";
import type { JsonValue } from "../json.ts";
import type { ObjectsError } from "../data/index.ts";
import { SealToken } from "../documents/fence.ts";
import type { Outcome } from "./definition.ts";

export interface Run<O> {
	readonly id: string;
	outcome(context: Context): Promise<O>;
}
export type BlockedReason = "finish_failed" | "version";
export type Phase = "pending" | "running" | "stopped" | "finishing" | "blocked";
export type AnyOutcome = Outcome<JsonValue, unknown, JsonValue | undefined>;
type Answer<T> =
	| { readonly kind: "done"; readonly value: T }
	| { readonly kind: "failed"; readonly error: ObjectsError };

class Completion<T> {
	#answer: Answer<T> | undefined;
	readonly #waiting = new Set<(answer: Answer<T>) => void>();
	settle(answer: Answer<T>): void {
		if (this.#answer) return;
		this.#answer = answer;
		for (const waiter of this.#waiting) waiter(answer);
		this.#waiting.clear();
	}
	wait(context: Context): Promise<T> {
		const answer = this.#answer;
		if (answer) return answer.kind === "done" ? Promise.resolve(answer.value) : Promise.reject(answer.error);
		const signal = context.abortSignal;
		if (signal?.aborted) return Promise.reject(signal.reason);
		return new Promise<T>((resolve, reject) => {
			const abort = (): void => {
				this.#waiting.delete(complete);
				reject(signal?.reason);
			};
			const complete = (answer: Answer<T>): void => {
				signal?.removeEventListener("abort", abort);
				if (answer.kind === "done") resolve(answer.value);
				else reject(answer.error);
			};
			this.#waiting.add(complete);
			signal?.addEventListener("abort", abort, { once: true });
		});
	}
}
export class Invocation {
	readonly token = new SealToken();
	readonly abort = new AbortController();
	state: "running" | "settled" = "running";
	readonly #completion = new Completion<void>();
	settle(): void {
		this.state = "settled";
	}
	ended(): void {
		this.#completion.settle({ kind: "done", value: undefined });
	}
	over(context: Context): Promise<void> {
		return this.#completion.wait(context);
	}
}

export class JobRun {
	readonly id: string;
	readonly version: number;
	readonly fingerprint: string;
	readonly key: string | undefined;
	readonly args: JsonValue;
	readonly handle: Run<AnyOutcome>;
	readonly trace: { readonly [key: string]: string } | undefined;
	invocation: Invocation | undefined;
	blockedPhase: Phase | undefined;
	mapped: { readonly version: number; readonly args: JsonValue; outcome?: AnyOutcome } | undefined;
	phase: Phase;
	restarts = 0;
	finishFailures = 0;
	abortMarked = false;
	resuming = false;
	blocked: BlockedReason | undefined;
	outcome: AnyOutcome | undefined;
	entry: JsonValue | undefined;
	readonly #completion = new Completion<AnyOutcome>();
	constructor(
		id: string,
		version: number,
		fingerprint: string,
		key: string | undefined,
		args: JsonValue,
		phase: Phase,
		trace?: { readonly [key: string]: string },
	) {
		this.id = id;
		this.version = version;
		this.fingerprint = fingerprint;
		this.key = key;
		this.args = args;
		this.phase = phase;
		this.trace = trace;
		const completion = this.#completion;
		this.handle = { id, outcome: (context) => completion.wait(context) };
	}
	entryFor(state: JsonValue | undefined, args: JsonValue): JsonValue {
		const { id, version, key } = this;
		if (this.phase === "blocked") return { id, version, phase: "blocked", reason: this.blocked! };
		return {
			id,
			version,
			...(key === undefined ? {} : { key }),
			args,
			...(state === undefined ? {} : { state }),
			phase: this.phase === "finishing" ? "finishing" : "running",
		};
	}
	begin(): Invocation {
		return (this.invocation = new Invocation());
	}
	get invoked(): boolean {
		return this.invocation?.state === "running";
	}
	over(context: Context): Promise<void> {
		return this.invocation?.state === "running" ? this.invocation.over(context) : Promise.resolve();
	}
	resolve(outcome: AnyOutcome): void {
		this.#completion.settle({ kind: "done", value: outcome });
	}
	reject(error: ObjectsError): void {
		this.#completion.settle({ kind: "failed", error });
	}
}
