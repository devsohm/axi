import { DurableObject } from "cloudflare:workers";
import compiledImport from "quickjs-wasi/quickjs.wasm";
import {
	DEFAULT_INTERRUPT_BUDGET,
	InlineCodemodeSandbox,
	type InlineCodemodeSandboxOptions,
} from "./runtime/inline.ts";
import { serveCodemodeRemote, type CodemodeRemoteRequest, type CodemodeRemoteExchange } from "./runtime/remote.ts";
import type { CodemodeWasmModule } from "./wasm.ts";
export * from "./portable.ts";
const wasm = compiledImport as CodemodeWasmModule;
export const DEFAULT_REMOTE_MEMORY_LIMIT_BYTES = 32 * 1024 * 1024;
export const cloudflareQuickJSWasm: CodemodeWasmModule = wasm;
export function createInlineCodemodeSandbox(
	options: Omit<InlineCodemodeSandboxOptions, "wasm"> = {},
): InlineCodemodeSandbox {
	return new InlineCodemodeSandbox({ ...options, wasm });
}
export class CodemodeSandboxDurableObject<Env = unknown> extends DurableObject<Env> {
	protected maxInterruptBudget: number = DEFAULT_INTERRUPT_BUDGET;
	protected maxMemoryLimitBytes: number = DEFAULT_REMOTE_MEMORY_LIMIT_BYTES;
	execute(request: CodemodeRemoteRequest, exchange: CodemodeRemoteExchange): Promise<void> {
		return serveCodemodeRemote(request, exchange, {
			wasm,
			maxInterruptBudget: this.maxInterruptBudget,
			maxMemoryLimitBytes: this.maxMemoryLimitBytes,
		});
	}
}
