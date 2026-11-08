import { expect, test } from "vitest";
import { CodemodeSandbox, InlineCodemodeSandbox, loadQuickJSWasm } from "../src/index.ts";

test("a rejected worker location releases its reservation before a worker can start", async () => {
	let reservations = 0,
		started = 0;
	const sandbox = new CodemodeSandbox({
		workerUrl: new URL("https://runtime.example.test/worker.js"),
		acquireWorker() {
			reservations++;
			return () => reservations--;
		},
		onWorkerStarted() {
			started++;
		},
	});
	try {
		expect(await sandbox.execute("return 42;")).toMatchObject({
			ok: false,
			error: { kind: "sandbox", message: expect.stringContaining("Failed to start worker") },
		});
		expect(reservations).toBe(0);
		expect(started).toBe(0);
	} finally {
		await sandbox.close();
	}
});

test("an incompatible WebAssembly module fails initialization in both runtime modes", async () => {
	const wasm = await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
	const exits: Promise<void>[] = [];
	for (const sandbox of [
		new InlineCodemodeSandbox({ wasm }),
		new CodemodeSandbox({ wasm, onWorkerStarted: (exit) => exits.push(exit) }),
	]) {
		try {
			expect(await sandbox.execute('store("key", 1); return 42;')).toMatchObject({
				ok: false,
				error: { kind: "sandbox" },
				calls: [],
				output: [],
			});
		} finally {
			await sandbox.close();
		}
	}
	await Promise.all(exits);
});

test("unbounded asynchronous jobs exhaust their interrupt budget and leave a fresh invocation usable", async () => {
	const sandbox = new InlineCodemodeSandbox({ wasm: loadQuickJSWasm(), interruptBudget: 5 });
	try {
		expect(
			await sandbox.execute("async function loop() { while (true) await Promise.resolve(); } return loop();"),
		).toMatchObject({ ok: false, error: { kind: "timeout" } });
		expect(await sandbox.execute("return 6 * 7;")).toMatchObject({ ok: true, value: 42 });
	} finally {
		await sandbox.close();
	}
});

test.each([false, true])(
	"recursive scripts fail within the sandbox and release the runtime, worker: %s",
	async (worker) => {
		const sandbox = worker ? new CodemodeSandbox() : new InlineCodemodeSandbox({ wasm: loadQuickJSWasm() });
		try {
			expect(await sandbox.execute("function recurse() { return recurse(); } return recurse();")).toMatchObject({
				ok: false,
				error: { kind: "script", message: expect.stringMatching(/stack/i) },
			});
			expect(await sandbox.execute("return 'usable';")).toMatchObject({ ok: true, value: "usable" });
		} finally {
			await sandbox.close();
		}
	},
);
