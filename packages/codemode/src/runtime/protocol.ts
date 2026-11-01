import type { CodemodeDuring, CodemodeOutputItem } from "../types.ts";
import type { CodemodeWasmModule } from "../wasm.ts";

export interface VmStartData {
	code: string;
	tools: { name: string; jsName: string; description: string }[];
	globals: { name: string; spread: boolean }[];
	memoryLimitBytes: number | undefined;
	store: Record<string, string>;
	deterministic?: { startedAt: number; seed: number };
}
export interface WorkerData extends VmStartData {
	wasm: CodemodeWasmModule;
	interrupt: SharedArrayBuffer;
}
export type ScriptErrorJson = string;
export type WorkerToHostMessage =
	| { type: "call"; id: number; target: "tool" | "global"; name: string; args: string | undefined }
	| { type: "output"; item: CodemodeOutputItem }
	| { type: "done"; ok: true; value: string | undefined; writes: string; during?: CodemodeDuring }
	| { type: "done"; ok: false; error: ScriptErrorJson; during?: CodemodeDuring }
	| { type: "crash"; message: string }
	| { type: "started"; fingerprint: string }
	| { type: "idle"; seq: number; issued: number };
export type HostToWorkerMessage = {
	type: "result";
	id: number;
	ok: boolean;
	payload: string | undefined;
	seq?: number;
	now?: number;
	properties?: string;
};
function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
export function isWorkerToHostMessage(value: unknown): value is WorkerToHostMessage {
	if (!record(value)) return false;
	const kind = value.type;
	return (
		kind === "call" || kind === "output" || kind === "done" || kind === "crash" || kind === "started" || kind === "idle"
	);
}
export function isHostToWorkerMessage(value: unknown): value is HostToWorkerMessage {
	return record(value) && value.type === "result";
}
