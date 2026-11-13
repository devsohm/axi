import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
	CodemodeSandbox,
	RemoteCodemodeSandbox,
	loadQuickJSWasm,
	type RemoteCodemodeSandboxOptions,
} from "../src/index.ts";

test("a failed WASM compilation can be retried after repairing the file and successful compilations are reused", async () => {
	const root = await mkdtemp(join(tmpdir(), "axi-wasm-retry-"));
	const file = join(root, "runtime.wasm");
	try {
		await writeFile(file, "not a WebAssembly module");
		const failed = loadQuickJSWasm(file);
		await expect(failed).rejects.toBeInstanceOf(WebAssembly.CompileError);
		await writeFile(file, await readFile(createRequire(import.meta.url).resolve("quickjs-wasi/quickjs.wasm")));
		const repaired = loadQuickJSWasm(file);
		expect(repaired).not.toBe(failed);
		expect(await repaired).toBeInstanceOf(WebAssembly.Module);
		expect(loadQuickJSWasm(file)).toBe(repaired);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("remote protocol failures produce sandbox errors without adopting malformed state", async () => {
	for (const [messages, message] of [
		[[{ type: "unknown" }], "unknown message"],
		[[null], "unknown message"],
		[[{ type: "crash", message: "peer stopped" }], "peer stopped"],
		[[{ type: "done", ok: true, writes: "{}" }], "not an array"],
		[[{ type: "done", ok: true, writes: "[null]" }], "malformed entry"],
		[[{ type: "done", ok: true, writes: '[["key",3]]' }], "malformed entry"],
		[[{ type: "done", ok: true, writes: '[["key","bad"]]' }], "not valid JSON"],
		[[{ type: "done", ok: true, writes: "[]", value: "bad" }], "return value is not valid JSON"],
		[[{ type: "done", ok: false, error: "null" }], "script error is not an object"],
		[[{ type: "done", ok: false, error: '{"message":3}' }], "script error is malformed"],
		[[{ type: "done", ok: false, error: '{"message":"bad","name":3}' }], "script error is malformed"],
		[[{ type: "done", ok: false, error: '{"message":"bad","stack":3}' }], "script error is malformed"],
	] satisfies [unknown, string][]) {
		const sandbox = new RemoteCodemodeSandbox({
			remote: () => ({
				async execute(_request, exchange) {
					await exchange(JSON.parse(JSON.stringify(messages)));
				},
			}),
		});
		try {
			expect(await sandbox.execute("return 42;")).toMatchObject({
				ok: false,
				error: { kind: "sandbox", message: expect.stringContaining(message) },
			});
		} finally {
			await sandbox.close();
		}
	}
});

test("remote startup, premature completion and non-Error rejection retain actionable diagnostics", async () => {
	for (const [remote, message] of [
		[
			() => {
				throw "connection refused";
			},
			"Failed to reach the remote sandbox: connection refused",
		],
		[() => ({ async execute() {} }), "Remote sandbox returned before the script settled"],
		[
			() => ({
				async execute() {
					throw 42;
				},
			}),
			"Remote sandbox failed: 42",
		],
	] satisfies [RemoteCodemodeSandboxOptions["remote"], string][]) {
		const sandbox = new RemoteCodemodeSandbox({ remote });
		try {
			expect(await sandbox.execute("return 42;")).toMatchObject({ ok: false, error: { kind: "sandbox", message } });
		} finally {
			await sandbox.close();
		}
	}
});

test("cancelling a remote invocation releases its pending reply and cancels its host call", async () => {
	const entered = Promise.withResolvers<AbortSignal>();
	const remoteClosed = Promise.withResolvers<void>();
	const replies: unknown[] = [];
	const controller = new AbortController();
	const sandbox = new RemoteCodemodeSandbox({
		tools: [
			{
				name: "wait",
				execute(_args, { signal }) {
					entered.resolve(signal);
					return new Promise(() => {});
				},
			},
		],
		remote: () => ({
			async execute(_request, exchange) {
				try {
					replies.push(await exchange([{ type: "call", id: 1, target: "tool", name: "wait", args: undefined }]));
					replies.push(await exchange([{ type: "call", id: 2, target: "tool", name: "wait", args: undefined }]));
				} finally {
					remoteClosed.resolve();
				}
			},
		}),
	});
	try {
		const result = sandbox.execute("return await tools.wait();", { signal: controller.signal });
		const signal = await entered.promise;
		controller.abort(new Error("caller stopped"));
		expect(await result).toMatchObject({
			ok: false,
			error: { kind: "aborted", message: "caller stopped" },
			calls: [{ status: "cancelled" }],
		});
		await remoteClosed.promise;
		expect(replies).toEqual([{ type: "stop" }, { type: "stop" }]);
		expect(signal.aborted).toBe(true);
	} finally {
		await sandbox.close();
	}
});

test("an unresponsive remote invocation respects its deadline", async () => {
	const sandbox = new RemoteCodemodeSandbox({ remote: () => ({ execute: () => new Promise(() => {}) }) });
	try {
		expect(await sandbox.execute("return 42;", { timeoutMs: 10 })).toMatchObject({
			ok: false,
			error: { kind: "timeout" },
		});
	} finally {
		await sandbox.close();
	}
});

test("worker startup failures settle execution and release the worker", async () => {
	const exited: Promise<void>[] = [];
	const sandbox = new CodemodeSandbox({
		workerUrl: new URL('data:text/javascript,throw new Error("worker unavailable");'),
		onWorkerStarted(value) {
			exited.push(value);
		},
	});
	try {
		expect(await sandbox.execute("return 42;")).toMatchObject({
			ok: false,
			error: { kind: "sandbox", message: "worker unavailable" },
		});
	} finally {
		await sandbox.close();
		await Promise.all(exited);
	}
});

test("worker non-Error failures settle execution and release capacity", async () => {
	let reserved = 0;
	const exited: Promise<void>[] = [];
	const sandbox = new CodemodeSandbox({
		workerUrl: new URL("data:text/javascript,throw%2042"),
		acquireWorker() {
			reserved++;
			return () => {
				reserved--;
			};
		},
		onWorkerStarted: (exit) => exited.push(exit),
	});
	try {
		expect(await sandbox.execute("return 42;")).toMatchObject({ ok: false, error: { kind: "sandbox", message: "42" } });
		await Promise.all(exited);
		expect(reserved).toBe(0);
	} finally {
		await sandbox.close();
	}
});

test("a remote rejection after caller cancellation cannot replace the cancelled outcome", async () => {
	const entered = Promise.withResolvers<void>();
	const remote = Promise.withResolvers<void>();
	const controller = new AbortController();
	const sandbox = new RemoteCodemodeSandbox({
		remote: () => ({
			execute() {
				entered.resolve();
				return remote.promise;
			},
		}),
	});
	try {
		const pending = sandbox.execute("return 42;", { signal: controller.signal });
		await entered.promise;
		controller.abort(new Error("caller cancelled"));
		const result = await pending;
		expect(result).toMatchObject({ ok: false, error: { kind: "aborted", message: "caller cancelled" } });
		remote.reject(new Error("late disconnect"));
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(await pending).toBe(result);
	} finally {
		remote.resolve();
		await sandbox.close();
	}
});

test("worker import-watch notifications cannot interrupt a valid execution result", async () => {
	const exits: Promise<void>[] = [];
	const source = `import { parentPort } from 'node:worker_threads';
		parentPort.postMessage({'watch:import':'dependency.ts'});
		parentPort.postMessage({'watch:require':'dependency.cjs'});
		parentPort.postMessage({type:'done',ok:true,value:'42',writes:'[]'});`;
	const sandbox = new CodemodeSandbox({
		workerUrl: new URL(`data:text/javascript,${encodeURIComponent(source)}`),
		onWorkerStarted: (exit) => exits.push(exit),
	});
	try {
		expect(await sandbox.execute("return 42;")).toMatchObject({ ok: true, value: 42, calls: [], output: [] });
	} finally {
		await sandbox.close();
		await Promise.all(exits);
	}
});

test("a worker that exits without sending a terminal result rejects without retaining its reservation", async () => {
	let reservations = 0;
	const exits: Promise<void>[] = [];
	const sandbox = new CodemodeSandbox({
		workerUrl: new URL("data:text/javascript,process.exit(7)"),
		acquireWorker() {
			reservations++;
			return () => {
				reservations--;
			};
		},
		onWorkerStarted: (exit) => exits.push(exit),
	});
	try {
		expect(await sandbox.execute("return 42;")).toMatchObject({
			ok: false,
			error: { kind: "sandbox", message: "Worker exited with code 7 before the script settled" },
		});
		await Promise.all(exits);
		expect(reservations).toBe(0);
	} finally {
		await sandbox.close();
	}
});
