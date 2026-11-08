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
		expect(replies).toEqual([{ type: "stop" }]);
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
