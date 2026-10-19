import type { CodemodeWasmModule } from "./wasm.ts";

export interface CodemodeToolContext {
	signal: AbortSignal;
}
export type CodemodeJsonSchema = boolean | { [key: string]: unknown };
export interface CodemodeTool {
	name: string;
	description?: string;
	inputSchema?: CodemodeJsonSchema;
	outputSchema?: CodemodeJsonSchema;
	spread?: boolean;
	signature?: string;
	execute(args: unknown, context: CodemodeToolContext): unknown | Promise<unknown>;
}
export type CodemodeOutputItem =
	| { type: "text"; text: string; console?: true }
	| { type: "image"; data: string; mimeType: string };
export type CodemodeCallStatus = "ok" | "error" | "cancelled";
export interface CodemodeCall {
	name: string;
	status: CodemodeCallStatus;
	durationMs: number;
}
export type CodemodeErrorKind = "script" | "timeout" | "aborted" | "sandbox";
export interface CodemodeError {
	kind: CodemodeErrorKind;
	name?: string;
	message: string;
	stack?: string;
}
export interface CodemodeStoreWrites {
	set: Record<string, unknown>;
	delete: string[];
}
export interface CodemodeDuring {
	seq: number;
	issued: number;
}
type RunOutput = { output: CodemodeOutputItem[]; calls: CodemodeCall[]; during?: CodemodeDuring };
export type CodemodeResult = RunOutput &
	({ ok: true; value: unknown; storeWrites: CodemodeStoreWrites } | { ok: false; error: CodemodeError });
export interface CodemodeSandboxBaseOptions {
	tools?: CodemodeTool[];
	globals?: CodemodeTool[];
	timeoutMs?: number;
	memoryLimitBytes?: number;
}
export interface CodemodeSandboxOptions extends CodemodeSandboxBaseOptions {
	wasm?: CodemodeWasmModule | Promise<CodemodeWasmModule>;
	workerUrl?: string | URL;
	acquireWorker?(): () => void;
	onWorkerStarted?(exited: Promise<void>): void;
}
export interface CodemodeHostCall {
	id: number;
	target: "tool" | "global";
	name: string;
	args: unknown;
}
export interface CodemodeDeclaredTool {
	name: string;
	jsName?: string;
	description?: string;
}
export interface CodemodeDeclaredGlobal {
	name: string;
	spread?: boolean;
}
export type CodemodeOutcome =
	| { ok: true; value: unknown }
	| { ok: false; message: string; properties?: Record<string, unknown> };
export interface CodemodeExecuteOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
	store?: Readonly<Record<string, unknown>>;
}
export interface CodemodeRunOptions extends CodemodeExecuteOptions {
	startedAt: number;
	seed: number;
	tools?: CodemodeDeclaredTool[];
	globals?: CodemodeDeclaredGlobal[];
	onStarted?(fingerprint: string): void;
	onCall(call: CodemodeHostCall): void;
	onIdle?(seq: number, issued: number): void;
}
export interface CodemodeRun {
	readonly result: Promise<CodemodeResult>;
	readonly finished: boolean;
	deliver(seq: number, now: number, id: number, outcome: CodemodeOutcome): void;
}
