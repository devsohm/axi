import type { JsonValue } from "../json.ts";
import type { JsonObject } from "../documents/index.ts";
import { errorFromWire, wireError } from "../link/errors.ts";
import type { WireError } from "../link/message.ts";
import type { JobError } from "./definition.ts";
import type { AnyOutcome, BlockedReason, JobRun, Phase } from "./run.ts";

export type StoredJobError =
	| { readonly kind: "threw"; readonly error: WireError }
	| {
			readonly kind: "aborted";
			readonly reason: "abort" | "reload" | "restart";
	  }
	| { readonly kind: "restart_limit"; readonly restarts: number };
export type StoredOutcome =
	| { readonly kind: "done"; readonly result: JsonValue }
	| { readonly kind: "failed"; readonly error: StoredJobError };
export type StoredRun = {
	readonly version: number;
	readonly fingerprint: string;
	readonly args: JsonValue;
	readonly key?: string;
	readonly trace?: { readonly [key: string]: string };
	readonly phase: Phase;
	readonly restarts: number;
	readonly finishFailures: number;
	readonly abort?: true;
	readonly blocked?: BlockedReason;
	readonly outcome?: StoredOutcome;
};
export const RUN_RECORD = {
	version: 1,
	fingerprint: "objects.job-run.1",
} as const;
export type StoredFields = {
	readonly phase?: Phase;
	readonly restarts?: number;
	readonly finishFailures?: number;
	readonly abortMarked?: true;
	readonly blocked?: BlockedReason;
	readonly outcome?: AnyOutcome;
};

export function storedRun(
	run: JobRun,
	fields: StoredFields = {},
): StoredRun {
	const state = {
		phase: run.phase,
		restarts: run.restarts,
		finishFailures: run.finishFailures,
		abortMarked: run.abortMarked,
		blocked: run.blocked,
		outcome: run.outcome,
		...fields,
	};
	return {
		version: run.version,
		fingerprint: run.fingerprint,
		args: run.args,
		...(run.key === undefined ? {} : { key: run.key }),
		...(run.trace === undefined ? {} : { trace: run.trace }),
		phase: state.phase,
		restarts: state.restarts,
		finishFailures: state.finishFailures,
		...(state.abortMarked ? { abort: true as const } : {}),
		...(state.blocked === undefined ? {} : { blocked: state.blocked }),
		...(state.outcome === undefined
			? {}
			: { outcome: encodeOutcome(state.outcome) }),
	};
}
function encodeOutcome(outcome: AnyOutcome): StoredOutcome {
	if (outcome.kind === "done")
		return { kind: "done", result: outcome.result as JsonValue };
	const error = outcome.error;
	return {
		kind: "failed",
		error:
			error.kind === "threw"
				? { kind: "threw", error: wireError(error.error) }
				: error,
	};
}
export function outcomeOf(
	stored: StoredOutcome,
	id: string,
	args: JsonValue,
	state: JsonValue | undefined,
): AnyOutcome {
	if (stored.kind === "done")
		return { kind: "done", id, args, state, result: stored.result };
	const error: JobError =
		stored.error.kind === "threw"
			? { kind: "threw", error: errorFromWire(stored.error.error) }
			: stored.error;
	return { kind: "failed", id, args, state, error };
}
export function recordOf(value: JsonObject): StoredRun {
	return value as unknown as StoredRun;
}
