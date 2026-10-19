export const CHORD_ERROR_CODES = [
	"aborted",
	"contract_mismatch",
	"forbidden",
	"gone",
	"invalid",
	"not_in_variant",
	"not_ready",
	"released",
	"superseded",
	"unavailable",
	"upgrade_conflict",
	"upgrade_required",
] as const;
export type ChordErrorCode = (typeof CHORD_ERROR_CODES)[number];
export type ChordErrorReason = string;
const retryable: ReadonlySet<ChordErrorCode> = new Set(["superseded", "upgrade_conflict"]);
export class ChordError extends Error {
	readonly code: ChordErrorCode;
	readonly reason: ChordErrorReason | undefined;
	readonly retryable: boolean;
	readonly details: unknown;
	constructor(
		code: ChordErrorCode,
		message: string,
		options?: { cause?: unknown; details?: unknown; reason?: ChordErrorReason },
	) {
		const qualifier = options?.reason ? `${code}/${options.reason}` : code;
		super(`${qualifier}: ${message}`, { cause: options?.cause });
		this.name = "ChordError";
		this.code = code;
		this.reason = options?.reason;
		this.retryable = retryable.has(code);
		this.details = options?.details;
	}
}
export function isChordError(error: unknown, code?: ChordErrorCode): error is ChordError {
	return error instanceof ChordError && (code === undefined || code === error.code);
}
export function forbidden(message = "forbidden"): ChordError {
	return new ChordError("forbidden", message);
}
export function invalid(reason: ChordErrorReason, message: string, details?: unknown): ChordError {
	return new ChordError("invalid", message, { reason, details });
}
export function asChordError(error: unknown, context: string): ChordError {
	return isChordError(error)
		? error
		: new ChordError("unavailable", `${context}: ${error instanceof Error ? error.message : String(error)}`, {
				cause: error,
			});
}
export async function runAll(steps: readonly (() => unknown)[], message: string): Promise<void> {
	const failures: unknown[] = [];
	for (const step of steps) {
		try {
			await step();
		} catch (error) {
			failures.push(error);
		}
	}
	if (failures.length === 1) throw failures[0];
	if (failures.length) throw new AggregateError(failures, message);
}
