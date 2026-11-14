import type { JsonValue } from "../json.ts";

export const PROTOCOL_VERSION = 1;
export const OBJECTS_ERROR_REASONS = {
	invalid: ["args", "params", "member", "host_address", "reentrant", "read_after_bulk", "cycle"],
	contract_mismatch: ["updating"],
	forbidden: ["revoked"],
	gone: [],
	not_ready: [],
	released: ["ended", "closed", "settled", "version", "discarded"],
	too_large: ["part"],
	unavailable: ["locked", "park_timeout", "busy", "storage_failed", "undeclared", "version", "reload_cycle"],
	aborted: [],
} as const;
export type ObjectsErrorCode = keyof typeof OBJECTS_ERROR_REASONS;
export type ObjectsErrorReason<C extends ObjectsErrorCode = ObjectsErrorCode> =
	(typeof OBJECTS_ERROR_REASONS)[C][number];
type Envelope = {
	[C in ObjectsErrorCode]: {
		readonly code: C;
		readonly message: string;
		readonly details?: JsonValue;
	} & (C extends "invalid" ? { readonly reason: ObjectsErrorReason<C> } : { readonly reason?: ObjectsErrorReason<C> });
}[ObjectsErrorCode];

class RuntimeError extends Error {
	readonly code: ObjectsErrorCode;
	readonly reason: ObjectsErrorReason | undefined;
	readonly details: JsonValue | undefined;
	constructor(fields: Envelope, options?: ErrorOptions) {
		super(fields.message, options);
		this.name = "ObjectsError";
		this.code = fields.code;
		this.reason = fields.reason;
		this.details = fields.details;
	}
	toJSON(): Envelope {
		return {
			code: this.code,
			message: this.message,
			...(this.reason === undefined ? {} : { reason: this.reason }),
			...(this.details === undefined ? {} : { details: this.details }),
		} as Envelope;
	}
}
export type ObjectsError = RuntimeError & Envelope;
// The constructor preserves the code/reason pairing; classes cannot declare a union as their instance type.
export const ObjectsError = RuntimeError as new (fields: Envelope, options?: ErrorOptions) => ObjectsError;
export function isObjectsError<C extends ObjectsErrorCode = ObjectsErrorCode>(
	value: unknown,
	code?: C,
): value is Extract<ObjectsError, { readonly code: C }> {
	return value instanceof RuntimeError && (code === undefined || value.code === code);
}
export class PluginError extends Error {
	readonly code: string;
	readonly details: JsonValue | undefined;
	constructor(code: string, message: string, details?: JsonValue) {
		super(message);
		this.name = "PluginError";
		this.code = code;
		this.details = details;
	}
}
export function invalid(
	reason: ObjectsErrorReason<"invalid">,
	message: string,
	details?: JsonValue,
): Extract<ObjectsError, { readonly code: "invalid" }> {
	return new ObjectsError({
		code: "invalid",
		reason,
		message,
		...(details === undefined ? {} : { details }),
	}) as Extract<ObjectsError, { readonly code: "invalid" }>;
}
export function asObjectsError(value: unknown, label: string): ObjectsError {
	if (isObjectsError(value)) return value;
	return new ObjectsError(
		{ code: "unavailable", message: `${label}: ${value instanceof Error ? value.message : String(value)}` },
		{ cause: value },
	);
}
export function forbidden(message: string, details?: JsonValue): Extract<ObjectsError, { readonly code: "forbidden" }> {
	return new ObjectsError({ code: "forbidden", message, ...(details === undefined ? {} : { details }) }) as Extract<
		ObjectsError,
		{ readonly code: "forbidden" }
	>;
}
export function objectsErrorFromJson(raw: unknown): ObjectsError {
	const reject = (problem: string): never => {
		throw new Error(`Invalid ObjectsError JSON: ${problem}`);
	};
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return reject("not an object");
	const fields = raw as Record<string, unknown>;
	for (const key of Object.keys(fields))
		if (!["code", "reason", "message", "details"].includes(key)) reject(`unknown key "${key}"`);
	const { code, reason, message } = fields;
	if (typeof code !== "string" || !Object.hasOwn(OBJECTS_ERROR_REASONS, code)) return reject("unknown code");
	const reasons: readonly unknown[] = OBJECTS_ERROR_REASONS[code as ObjectsErrorCode];
	if ((reason === undefined && code === "invalid") || (reason !== undefined && !reasons.includes(reason)))
		return reject(`reason not allowed for ${code}`);
	if (typeof message !== "string") return reject("message is not a string");
	return new ObjectsError(fields as Envelope);
}
