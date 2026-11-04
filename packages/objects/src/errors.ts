export const OBJECTS_ERROR_CODES = [
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
export type ObjectsErrorCode = (typeof OBJECTS_ERROR_CODES)[number];
export type ObjectsErrorReason = string;
const retryable: ReadonlySet<ObjectsErrorCode> = new Set(["superseded", "upgrade_conflict"]);
export class ObjectsError extends Error {
	readonly code: ObjectsErrorCode;
	readonly reason: ObjectsErrorReason | undefined;
	readonly retryable: boolean;
	readonly details: unknown;
	constructor(
		code: ObjectsErrorCode,
		message: string,
		options?: { cause?: unknown; details?: unknown; reason?: ObjectsErrorReason },
	) {
		const qualifier = options?.reason ? `${code}/${options.reason}` : code;
		super(`${qualifier}: ${message}`, { cause: options?.cause });
		this.name = "ObjectsError";
		this.code = code;
		this.reason = options?.reason;
		this.retryable = retryable.has(code);
		this.details = options?.details;
	}
}
export function isObjectsError(error: unknown, code?: ObjectsErrorCode): error is ObjectsError {
	return error instanceof ObjectsError && (code === undefined || code === error.code);
}
export function forbidden(message = "forbidden"): ObjectsError {
	return new ObjectsError("forbidden", message);
}
export function invalid(reason: ObjectsErrorReason, message: string, details?: unknown): ObjectsError {
	return new ObjectsError("invalid", message, { reason, details });
}
export function asObjectsError(error: unknown, context: string): ObjectsError {
	return isObjectsError(error)
		? error
		: new ObjectsError("unavailable", `${context}: ${error instanceof Error ? error.message : String(error)}`, {
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
