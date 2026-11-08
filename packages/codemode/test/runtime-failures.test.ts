import { expect, test } from "vitest";
import {
	CodemodeSandbox,
	CodemodeSandboxBase,
	InlineCodemodeSandbox,
	RemoteCodemodeSandbox,
	loadQuickJSWasm,
	serveCodemodeRemote,
	type CodemodeHostCall,
	type CodemodeRemoteMessage,
} from "../src/index.ts";

test("syntax failures release inline and worker runtimes without committing store changes", async () => {
	for (const sandbox of [new InlineCodemodeSandbox({ wasm: loadQuickJSWasm() }), new CodemodeSandbox()]) {
		try {
			expect(await sandbox.execute('store("key", "uncommitted"); return {')).toMatchObject({
				ok: false,
				error: { kind: "script", name: "SyntaxError", stack: expect.stringContaining("SyntaxError") },
				calls: [],
				output: [],
			});
			expect(await sandbox.execute('return load("key");')).toMatchObject({
				ok: true,
				value: undefined,
				storeWrites: { set: {}, delete: [] },
			});
		} finally {
			await sandbox.close();
		}
	}
});

test("undefined host results and non-Error rejections remain usable inside the script", async () => {
	const sandbox = new InlineCodemodeSandbox({
		wasm: loadQuickJSWasm(),
		tools: [
			{ name: "absent", execute() {} },
			{
				name: "reject",
				execute() {
					throw "offline";
				},
			},
		],
		globals: [{ name: "host.absent", execute() {} }],
	});
	try {
		const result = await sandbox.execute(`
const values = [typeof await tools.absent(), typeof await host.absent()];
try { await tools.reject(); } catch (error) { values.push(error.message); }
return values;`);
		expect(result).toMatchObject({
			ok: true,
			value: ["undefined", "undefined", "offline"],
			calls: [
				{ name: "absent", status: "ok" },
				{ name: "reject", status: "error" },
			],
		});
	} finally {
		await sandbox.close();
	}
});

test("unregistered remote tool and global calls fail individually instead of leaving the peer waiting", async () => {
	for (const target of ["tool", "global"] as const) {
		const sandbox = new RemoteCodemodeSandbox({
			remote: () => ({
				async execute(_request, exchange) {
					const response = await exchange([{ type: "call", id: 1, target, name: "missing", args: undefined }]);
					expect(response).toMatchObject({ type: "result", ok: false, payload: `Unknown ${target} "missing"` });
					await exchange([{ type: "done", ok: true, value: '"handled"', writes: "[]" }]);
				},
			}),
		});
		try {
			expect(await sandbox.execute("return 42;")).toMatchObject({
				ok: true,
				value: "handled",
				calls: target === "tool" ? [{ name: "missing", status: "error" }] : [],
			});
		} finally {
			await sandbox.close();
		}
	}
});

test("exceptions in deterministic run observers settle their run as a host failure", async () => {
	for (const observer of ["onStarted", "onIdle", "onCall"] as const) {
		const sandbox = new InlineCodemodeSandbox({ wasm: loadQuickJSWasm() });
		try {
			const run = sandbox.start("return host.wait();", {
				startedAt: 10,
				seed: 1,
				globals: [{ name: "host.wait" }],
				onCall() {},
				[observer]() {
					throw new Error(`${observer} failed`);
				},
			});
			expect(await run.result).toMatchObject({
				ok: false,
				error: { kind: "sandbox", message: `Sandbox host failed: ${observer} failed` },
				calls: [],
			});
			expect(run.finished).toBe(true);
		} finally {
			await sandbox.close();
		}
	}
});

test("late host completion after cancellation cannot deliver a second result", async () => {
	const entered = Promise.withResolvers<AbortSignal>();
	const answer = Promise.withResolvers<string>();
	const controller = new AbortController();
	const sandbox = new InlineCodemodeSandbox({
		wasm: loadQuickJSWasm(),
		globals: [
			{
				name: "host.wait",
				execute(_args, { signal }) {
					entered.resolve(signal);
					return answer.promise;
				},
			},
		],
	});
	try {
		const result = sandbox.execute('const answer = await host.wait(); store("late", answer); return answer;', {
			signal: controller.signal,
		});
		const signal = await entered.promise;
		controller.abort("stop");
		expect(await result).toMatchObject({
			ok: false,
			error: { kind: "aborted", message: "Execution aborted" },
			calls: [],
		});
		expect(signal.aborted).toBe(true);
		answer.resolve("too late");
		await answer.promise;
		expect(await sandbox.execute('return load("late");')).toMatchObject({ ok: true, value: undefined });
	} finally {
		await sandbox.close();
	}
});

test("closing during asynchronous startup closes the late channel even if its shutdown rejects", async () => {
	const started = Promise.withResolvers<{ post(): void; stop(): Promise<void> }>();
	const stopped = Promise.withResolvers<void>();
	const sandbox = new CodemodeSandboxBase({}, () => started.promise);
	const result = sandbox.execute("return 42;");
	await sandbox.close();
	expect(await result).toMatchObject({ ok: false, error: { kind: "aborted" } });
	started.resolve({
		post() {
			throw new Error("closed channel received a message");
		},
		async stop() {
			stopped.resolve();
			throw new Error("channel already lost");
		},
	});
	await stopped.promise;
	await sandbox.close();
});

test("the remote service caps computation and releases the runtime when exchange fails", async () => {
	const request = {
		data: { code: "while (true) {}", tools: [], globals: [], memoryLimitBytes: undefined, store: {} },
		interruptBudget: 10000,
	};
	const messages: CodemodeRemoteMessage[] = [];
	await serveCodemodeRemote(
		request,
		async (batch) => {
			messages.push(...batch);
			throw new Error("connection lost");
		},
		{
			wasm: loadQuickJSWasm(),
			maxInterruptBudget: 5,
			maxMemoryLimitBytes: 16 * 1024 * 1024,
		},
	);
	expect(messages).toContainEqual({
		type: "failure",
		error: { kind: "timeout", message: "Execution exceeded its interrupt budget of 5" },
	});
	for (const memory of [undefined, 32 * 1024 * 1024]) {
		const outputs: CodemodeRemoteMessage[] = [];
		await serveCodemodeRemote(
			{ data: { ...request.data, code: "return 42;", memoryLimitBytes: memory } },
			async (batch) => {
				outputs.push(...batch);
				return null;
			},
			{
				wasm: loadQuickJSWasm(),
				maxMemoryLimitBytes: 16 * 1024 * 1024,
			},
		);
		expect(outputs).toContainEqual(expect.objectContaining({ type: "done", ok: true, value: "42" }));
	}
});

test("a deterministically delivered undefined global result leaves the tool-call list empty", async () => {
	const pending = Promise.withResolvers<CodemodeHostCall>();
	const sandbox = new InlineCodemodeSandbox({ wasm: loadQuickJSWasm() });
	const run = sandbox.start("return typeof await host.value();", {
		startedAt: 10,
		seed: 0,
		globals: [{ name: "host.value" }],
		onCall: pending.resolve,
	});
	try {
		const call = await pending.promise;
		run.deliver(1, 15, call.id, { ok: true, value: undefined });
		expect(await run.result).toMatchObject({ ok: true, value: "undefined", calls: [], during: { seq: 1, issued: 1 } });
	} finally {
		await sandbox.close();
	}
});
