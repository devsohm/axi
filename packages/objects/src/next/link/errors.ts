import type { JsonValue } from "../../json.ts";
import { isObjectsError, PluginError, type ObjectsError } from "../data/index.ts";
import { objectsErrorFromJson } from "../data/internal.ts";
import type { WireError } from "./message.ts";

export function wireError(error: unknown): WireError {
	if (isObjectsError(error)) return { kind: "objects", error: error.toJSON() };
	if (error instanceof PluginError)
		return {
			kind: "plugin",
			code: error.code,
			message: error.message,
			...(error.details === undefined ? {} : { details: error.details }),
		};
	return {
		kind: "plugin",
		code: "internal",
		message: error instanceof Error ? error.message : String(error),
	};
}
export function errorFromWire(error: WireError): ObjectsError | PluginError {
	if (error.kind === "objects") return objectsErrorFromJson(error.error);
	if (error.kind !== "plugin") throw new Error("wire error: unknown kind");
	return new PluginError(error.code, error.message, error.details as JsonValue | undefined);
}
