import { parentPort, workerData } from "node:worker_threads";
import { isHostToWorkerMessage, type WorkerData } from "./protocol.ts";
import { startVm } from "./vm.ts";
import { describeError } from "../errors.ts";
if (parentPort) {
	const port = parentPort,
		data = workerData as WorkerData,
		interrupt = new Int32Array(data.interrupt);
	void startVm({
		data,
		wasm: data.wasm,
		shouldInterrupt: () => Atomics.load(interrupt, 0) !== 0,
		post: (message) => port.postMessage(message),
	})
		.then((vm) =>
			port.on("message", (message: unknown) => {
				if (isHostToWorkerMessage(message)) vm.deliver(message);
			}),
		)
		.catch((error: unknown) =>
			port.postMessage({
				type: "crash",
				message: describeError(error),
			}),
		);
}
