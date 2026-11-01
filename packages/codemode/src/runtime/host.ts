import { Worker } from "node:worker_threads";
import type { CodemodeSandboxOptions } from "../types.ts";
import { loadQuickJSWasm, type CodemodeWasmModule } from "../wasm.ts";
import { CodemodeSandboxBase, errorMessage, type VmLauncher } from "./execution.ts";
import type { WorkerData } from "./protocol.ts";
function launcher(options: CodemodeSandboxOptions): VmLauncher {
	return async (data, events) => {
		let wasm: CodemodeWasmModule;
		try {
			wasm = await (options.wasm ?? loadQuickJSWasm());
		} catch (error) {
			throw new Error(`Failed to load QuickJS: ${errorMessage(error)}`);
		}
		const interrupt = new SharedArrayBuffer(4),
			release = options.acquireWorker?.();
		const workerData: WorkerData = { ...data, wasm, interrupt };
		let worker: Worker;
		try {
			worker = new Worker(
				options.workerUrl ?? new URL(import.meta.url.endsWith(".ts") ? "./worker.ts" : "./worker.js", import.meta.url),
				{ workerData },
			);
		} catch (error) {
			release?.();
			throw new Error(`Failed to start worker: ${errorMessage(error)}`);
		}
		if (release) worker.once("exit", release);
		worker.on("message", (message: unknown) => {
			if (typeof message === "object" && message !== null && ("watch:import" in message || "watch:require" in message))
				return;
			events.message(message);
		});
		worker.on("error", (error: unknown) =>
			events.failure({
				kind: "sandbox",
				name: error instanceof Error ? error.name : undefined,
				message: errorMessage(error),
			}),
		);
		worker.on("exit", (code) =>
			events.failure({ kind: "sandbox", message: `Worker exited with code ${code} before the script settled` }),
		);
		const stop = async (): Promise<void> => {
			Atomics.store(new Int32Array(interrupt), 0, 1);
			void worker.terminate().catch(() => undefined);
			worker.unref();
		};
		try {
			options.onWorkerStarted?.(new Promise<void>((resolve) => worker.once("exit", () => resolve())));
		} catch (error) {
			void stop();
			throw error;
		}
		return { post: (message) => worker.postMessage(message), stop };
	};
}
export class CodemodeSandbox extends CodemodeSandboxBase {
	constructor(options: CodemodeSandboxOptions = {}) {
		super(options, launcher(options));
	}
}
