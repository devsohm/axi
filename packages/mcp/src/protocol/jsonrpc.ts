export type JsonRpcId = number | string;
export interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: JsonRpcId;
	method: string;
	params?: unknown;
}
export interface JsonRpcNotification {
	jsonrpc: "2.0";
	method: string;
	params?: unknown;
}
export interface JsonRpcErrorObject {
	code: number;
	message: string;
	data?: unknown;
}
export interface JsonRpcSuccessResponse {
	jsonrpc: "2.0";
	id: JsonRpcId;
	result: unknown;
}
export interface JsonRpcErrorResponse {
	jsonrpc: "2.0";
	id: JsonRpcId;
	error: JsonRpcErrorObject;
}
export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;
export const JSON_RPC_ERROR_CODES = {
	parseError: -32700,
	invalidRequest: -32600,
	methodNotFound: -32601,
	invalidParams: -32602,
	internalError: -32603,
} as const;
export class McpError extends Error {
	readonly code: number;
	readonly data: unknown;
	constructor(code: number, message: string, data?: unknown) {
		super(message);
		this.name = "McpError";
		this.code = code;
		this.data = data;
	}
}
export class McpConnectionClosedError extends Error {
	constructor(message = "MCP connection closed") {
		super(message);
		this.name = "McpConnectionClosedError";
	}
}
export class McpTimeoutError extends Error {
	readonly timeoutMs: number;
	constructor(timeoutMs: number) {
		super(`MCP request timed out after ${timeoutMs}ms`);
		this.name = "McpTimeoutError";
		this.timeoutMs = timeoutMs;
	}
}
export class McpAbortError extends Error {
	constructor(message = "MCP request aborted") {
		super(message);
		this.name = "AbortError";
	}
}
export function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function toError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}
export function isJsonRpcId(value: unknown): value is JsonRpcId {
	return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}
export function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
	return isObject(value) && value.jsonrpc === "2.0" && isJsonRpcId(value.id) && typeof value.method === "string";
}
export function isJsonRpcNotification(value: unknown): value is JsonRpcNotification {
	return isObject(value) && value.jsonrpc === "2.0" && !("id" in value) && typeof value.method === "string";
}
export function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
	if (!isObject(value) || value.jsonrpc !== "2.0" || !isJsonRpcId(value.id)) return false;
	return "result" in value
		? !("error" in value)
		: "error" in value &&
				isObject(value.error) &&
				typeof value.error.code === "number" &&
				typeof value.error.message === "string";
}
export function parseJsonRpcMessage(value: unknown): JsonRpcMessage {
	if (isJsonRpcRequest(value) || isJsonRpcNotification(value) || isJsonRpcResponse(value)) return value;
	throw new McpError(JSON_RPC_ERROR_CODES.invalidRequest, "Invalid JSON-RPC message");
}
