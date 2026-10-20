import { expect, test } from "vitest";
import { InlineCodemodeSandbox, loadQuickJSWasm, type CodemodeHostCall } from "../src/index.ts";

test("deterministic execution delivers host results in explicit sequence and rejects duplicate delivery", async () => {
	const sandbox = new InlineCodemodeSandbox({ wasm: loadQuickJSWasm() });
	const entered = Promise.withResolvers<CodemodeHostCall>();
	const run = sandbox.start('return await tools.answer({ question: "life" });', {
		startedAt: 1000,
		seed: 7,
		tools: [{ name: "answer" }],
		onCall: (call) => entered.resolve(call),
	});
	try {
		const call = await entered.promise;
		expect({ name: call.name, target: call.target, args: call.args }).toEqual({
			name: "answer",
			target: "tool",
			args: { question: "life" },
		});
		expect(() => run.deliver(0, 1001, call.id, { ok: true, value: 42 })).toThrow("not a positive integer used once");
		expect(() => run.deliver(1, NaN, call.id, { ok: true, value: 42 })).toThrow("not a finite number");
		expect(() => run.deliver(1, 1001, call.id + 1, { ok: true, value: 42 })).toThrow("not waiting for a result");
		run.deliver(1, 1001, call.id, { ok: true, value: 42 });
		expect(() => run.deliver(1, 1001, call.id, { ok: true, value: 99 })).toThrow("not a positive integer used once");
		expect(await run.result).toMatchObject({ ok: true, value: 42, calls: [{ name: "answer", status: "ok" }] });
		expect(run.finished).toBe(true);
	} finally {
		await sandbox.close();
	}
});

test("script-visible host failures preserve structured error properties and unsuccessful calls", async () => {
	const sandbox = new InlineCodemodeSandbox({ wasm: loadQuickJSWasm() });
	const call = Promise.withResolvers<CodemodeHostCall>();
	const run = sandbox.start("try { await tools.answer(); } catch (error) { return [error.message, error.code]; }", {
		startedAt: 0,
		seed: 0,
		tools: [{ name: "answer" }],
		onCall: (value) => call.resolve(value),
	});
	try {
		run.deliver(1, 10, (await call.promise).id, {
			ok: false,
			message: "temporarily unavailable",
			properties: { code: "OFFLINE" },
		});
		expect(await run.result).toMatchObject({
			ok: true,
			value: ["temporarily unavailable", "OFFLINE"],
			calls: [{ name: "answer", status: "error" }],
		});
	} finally {
		await sandbox.close();
	}
});

test("closing an active sandbox aborts its host call and prevents later execution", async () => {
	const entered = Promise.withResolvers<AbortSignal>();
	const sandbox = new InlineCodemodeSandbox({
		wasm: loadQuickJSWasm(),
		tools: [
			{
				name: "wait",
				execute(_input, { signal }) {
					entered.resolve(signal);
					return new Promise(() => {});
				},
			},
		],
	});
	const result = sandbox.execute("return await tools.wait();");
	const signal = await entered.promise;
	await sandbox.close();
	expect(signal.aborted).toBe(true);
	expect(await result).toMatchObject({
		ok: false,
		error: { kind: "aborted", message: "Sandbox closed" },
		calls: [{ name: "wait", status: "cancelled" }],
	});
	await expect(sandbox.execute("return 42;")).rejects.toThrow("Sandbox is closed");
	await sandbox.close();
});

test("invalid deterministic configuration fails before executing code", async () => {
	const sandbox = new InlineCodemodeSandbox({ wasm: loadQuickJSWasm() });
	try {
		for (const options of [
			{ startedAt: -1, seed: 0 },
			{ startedAt: 0, seed: 0.5 },
			{ startedAt: 0, seed: 0, tools: [{ name: "x" }, { name: "x" }] },
			{
				startedAt: 0,
				seed: 0,
				tools: [
					{ name: "a", jsName: "x" },
					{ name: "b", jsName: "x" },
				],
			},
		])
			expect(() => sandbox.start("return 42;", { ...options, onCall() {} })).toThrow();
		expect(await sandbox.execute("return 42;")).toMatchObject({ ok: true, value: 42 });
	} finally {
		await sandbox.close();
	}
});
