import type { JsonObject } from "../types.ts";
export interface DiagnosticErrorInfo {
	name?: string;
	message: string;
	stack?: string;
	code?: string | number;
}
export interface AssistantMessageDiagnostic {
	type: string;
	timestamp: number;
	error?: DiagnosticErrorInfo;
	details?: JsonObject;
}
export function formatThrownValue(value: unknown): string {
	return value instanceof Error ? value.message || value.name : String(value);
}
export function extractDiagnosticError(error: unknown): DiagnosticErrorInfo {
	if (!(error instanceof Error)) return { name: "ThrownValue", message: formatThrownValue(error) };
	const code: unknown = Reflect.get(error, "code");
	return {
		name: error.name || undefined,
		message: error.message || error.name,
		stack: error.stack,
		code: typeof code === "string" || typeof code === "number" ? code : undefined,
	};
}
export function createAssistantMessageDiagnostic(
	type: string,
	error: unknown,
	details?: JsonObject,
): AssistantMessageDiagnostic {
	return { type, timestamp: Date.now(), error: extractDiagnosticError(error), details };
}
export function appendAssistantMessageDiagnostic<T extends { diagnostics?: AssistantMessageDiagnostic[] }>(
	message: T,
	diagnostic: AssistantMessageDiagnostic,
): void {
	message.diagnostics = [...(message.diagnostics ?? []), diagnostic];
}
