import type { CodemodeSandboxBaseOptions } from "../types.ts";
import type { CodemodeWasmModule } from "../wasm.ts";
import { CodemodeSandboxBase, errorMessage, type VmLauncher } from "./execution.ts";
import { startVm } from "./vm.ts";
export const DEFAULT_INTERRUPT_BUDGET = 100000;
export const INLINE_MAX_STACK_SIZE = 256 * 1024;
export interface InlineCodemodeSandboxOptions extends CodemodeSandboxBaseOptions {
	wasm: CodemodeWasmModule | Promise<CodemodeWasmModule>;
	interruptBudget?: number;
}
export function inlineLauncher(
	wasm: CodemodeWasmModule | Promise<CodemodeWasmModule>,
	interruptBudget = DEFAULT_INTERRUPT_BUDGET,
): VmLauncher {
	return async (data, events) => {
		let module: CodemodeWasmModule;
		try {
			module = await wasm;
		} catch (error) {
			throw new Error(`Failed to load QuickJS: ${errorMessage(error)}`);
		}
		let stopped = false,
			decided = false,
			exceeded = false,
			count = 0;
		const vm = await startVm({
			data,
			wasm: module,
			maxStackSize: INLINE_MAX_STACK_SIZE,
			interruptBudget,
			shouldInterrupt: () => stopped || decided || exceeded || (exceeded = !(++count <= interruptBudget)),
			post: (message) => {
				const terminal = message.type === "done" || message.type === "crash";
				if (terminal && decided) return;
				if (terminal) decided = true;
				queueMicrotask(() => {
					if (stopped) return;
					if (terminal && exceeded)
						events.failure({
							kind: "timeout",
							message: `Execution exceeded its interrupt budget of ${interruptBudget}`,
						});
					else events.message(message);
				});
			},
		});
		return {
			post: (message) => {
				if (!stopped) vm.deliver(message);
			},
			stop: async () => {
				if (!stopped) {
					stopped = true;
					vm.dispose();
				}
			},
		};
	};
}
export class InlineCodemodeSandbox extends CodemodeSandboxBase {
	constructor(options: InlineCodemodeSandboxOptions) {
		super(options, inlineLauncher(options.wasm, options.interruptBudget));
	}
}
