import { formatThrownValue } from "./diagnostics.ts";
export type ModelsErrorCode = "model_source" | "model_validation" | "provider" | "stream" | "auth" | "oauth";
export class ModelsError extends Error {
	readonly code: ModelsErrorCode;
	constructor(code: ModelsErrorCode, message: string, options?: { cause?: unknown }) {
		const cause = options?.cause;
		const detail = cause === undefined || cause === null ? "" : formatThrownValue(cause).trim();
		super(detail && !message.includes(detail) ? `${message}: ${detail}` : message, options);
		this.name = "ModelsError";
		this.code = code;
	}
}
