import { EventEmitter } from "node:events";
import { afterEach, expect, test, vi } from "vitest";
import { loadQuickJSWasm } from "../src/wasm.ts";
import type { WorkerData, WorkerToHostMessage } from "../src/runtime/protocol.ts";

const worker: {
	port: (EventEmitter & { postMessage(message: WorkerToHostMessage): void }) | null;
	data: WorkerData | undefined;
} = vi.hoisted(() => ({ port: null, data: undefined }));
vi.mock("node:worker_threads", () => ({
	get parentPort() {
		return worker.port;
	},
	get workerData() {
		return worker.data;
	},
}));

afterEach(() => {
	worker.port?.removeAllListeners();
	worker.port = null;
	worker.data = undefined;
	vi.resetModules();
});

test("the worker entry point is inert when imported outside a worker", async () => {
	await expect(import("../src/runtime/worker.ts")).resolves.toBeDefined();
	expect(worker.port).toBeNull();
});

test("the worker exchanges tool results and ignores unrelated parent messages", async () => {
	const messages: WorkerToHostMessage[] = [];
	const complete = Promise.withResolvers<WorkerToHostMessage>();
	worker.port = Object.assign(new EventEmitter(), {
		postMessage(message: WorkerToHostMessage) {
			messages.push(message);
			if (message.type === "done" || message.type === "crash") complete.resolve(message);
		},
	});
	worker.data = {
		wasm: await loadQuickJSWasm(),
		interrupt: new SharedArrayBuffer(4),
		code: "return await tools.double({value: 21});",
		tools: [{ name: "double", jsName: "double", description: "Double a number" }],
		globals: [],
		store: {},
		memoryLimitBytes: undefined,
	};
	await import("../src/runtime/worker.ts");
	await vi.waitFor(() => expect(worker.port?.listenerCount("message")).toBe(1));
	expect(messages).toEqual([{ type: "call", id: 1, target: "tool", name: "double", args: '{"value":21}' }]);
	for (const value of [null, 42, [], { type: "unknown" }]) worker.port.emit("message", value);
	expect(messages).toHaveLength(1);
	worker.port.emit("message", { type: "result", id: 1, ok: true, payload: "42" });
	expect(await complete.promise).toEqual({ type: "done", ok: true, value: "42", writes: "[]" });
});

test("a worker interrupted before execution reports failure without running the script", async () => {
	const complete = Promise.withResolvers<WorkerToHostMessage>();
	const interrupt = new SharedArrayBuffer(4);
	Atomics.store(new Int32Array(interrupt), 0, 1);
	worker.port = Object.assign(new EventEmitter(), { postMessage: complete.resolve });
	worker.data = {
		wasm: await loadQuickJSWasm(),
		interrupt,
		code: "while (true) {}",
		tools: [],
		globals: [],
		store: {},
		memoryLimitBytes: undefined,
	};
	await import("../src/runtime/worker.ts");
	expect(await complete.promise).toMatchObject({ type: "crash", message: expect.stringContaining("interrupted") });
});

test("a compiled module without a QuickJS runtime reports startup failure to its parent", async () => {
	const complete = Promise.withResolvers<WorkerToHostMessage>();
	worker.port = Object.assign(new EventEmitter(), { postMessage: complete.resolve });
	worker.data = {
		wasm: await WebAssembly.compile(Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0])),
		interrupt: new SharedArrayBuffer(4),
		code: "return 42;",
		tools: [],
		globals: [],
		store: {},
		memoryLimitBytes: undefined,
	};
	await import("../src/runtime/worker.ts");
	expect(await complete.promise).toMatchObject({ type: "crash", message: expect.stringContaining("TypeError:") });
});
