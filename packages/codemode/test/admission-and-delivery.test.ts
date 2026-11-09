import { expect, test } from "vitest";
import {
	CodemodeSandbox,
	InlineCodemodeSandbox,
	loadQuickJSWasm,
	RemoteCodemodeSandbox,
	serveCodemodeRemote,
	type CodemodeHostCall,
} from "../src/index.ts";

test("tool and global registration reject collisions before execution while removal changes the callable set", async () => {
	const wasm = await loadQuickJSWasm();
	for (const globals of [
		[{ name: "tools" }],
		[{ name: "a.b.c" }],
		[{ name: "bad-name" }],
		[{ name: "app" }, { name: "app.read" }],
		[{ name: "app.read" }, { name: "app.read" }],
	])
		expect(
			() => new InlineCodemodeSandbox({ wasm, globals: globals.map((global) => ({ ...global, execute: () => null })) }),
		).toThrow();
	const tool = { name: "answer", execute: () => 42 };
	const sandbox = new InlineCodemodeSandbox({
		wasm,
		tools: [tool],
		globals: [{ name: "app.value", execute: () => "value" }],
	});
	try {
		expect(() => sandbox.registerTool(tool)).toThrow(/already registered/);
		expect(sandbox.tools.map((tool) => tool.name)).toEqual(["answer"]);
		expect(sandbox.globals.map((global) => global.name)).toEqual(["app.value"]);
		expect(
			await sandbox.execute("return [await tools.answer(), await app.value()];", { store: { omitted: undefined } }),
		).toMatchObject({ ok: true, value: [42, "value"] });
		expect(sandbox.unregisterTool("answer")).toBe(true);
		expect(sandbox.unregisterTool("answer")).toBe(false);
		expect(await sandbox.execute("return tools.answer();")).toMatchObject({
			ok: false,
			error: { kind: "script", message: expect.stringContaining("answer") },
			calls: [],
		});
	} finally {
		await sandbox.close();
	}
	expect(() => sandbox.start("return 1;", { seed: 0, startedAt: 0, onCall() {} })).toThrow(/closed/);
});

test("malformed delivered error properties do not consume the result sequence or pending call", async () => {
	const entered = Promise.withResolvers<CodemodeHostCall>();
	const sandbox = new InlineCodemodeSandbox({ wasm: loadQuickJSWasm() });
	const run = sandbox.start(
		"try { return await tools.lookup(); } catch (error) { return [error.message, error.code]; }",
		{ startedAt: 10, seed: 0, tools: [{ name: "lookup" }], onCall: entered.resolve },
	);
	try {
		const call = await entered.promise;
		for (const properties of [null, [], "invalid"])
			expect(() =>
				Reflect.apply(run.deliver, run, [1, 20, call.id, { ok: false, message: "denied", properties }]),
			).toThrow(/not an object/);
		run.deliver(1, 20, call.id, { ok: false, message: "denied", properties: { code: "OFFLINE" } });
		expect(await run.result).toMatchObject({ ok: true, value: ["denied", "OFFLINE"], calls: [{ status: "error" }] });
		run.deliver(2, 30, call.id, { ok: true, value: "too late" });
	} finally {
		await sandbox.close();
	}
});

test("duplicate calls from a remote peer terminate the invocation and abort its outstanding host call", async () => {
	const sandbox = new RemoteCodemodeSandbox({
		tools: [{ name: "wait", execute: () => new Promise(() => {}) }],
		remote: () => ({
			async execute(_request, exchange) {
				await exchange([
					{ type: "call", id: 1, target: "tool", name: "wait", args: undefined },
					{ type: "call", id: 1, target: "tool", name: "wait", args: undefined },
				]);
			},
		}),
	});
	try {
		expect(await sandbox.execute("return tools.wait();")).toMatchObject({
			ok: false,
			error: { kind: "sandbox", message: expect.stringContaining("duplicate call") },
			calls: [{ status: "cancelled" }],
		});
	} finally {
		await sandbox.close();
	}
});

test("a failed worker-start observer releases its reservation after the worker exits", async () => {
	let reservations = 0;
	const exited: Promise<void>[] = [];
	const sandbox = new CodemodeSandbox({
		acquireWorker() {
			reservations++;
			return () => {
				reservations--;
			};
		},
		onWorkerStarted(exit) {
			exited.push(exit);
			throw new Error("observer failed");
		},
	});
	try {
		expect(await sandbox.execute("return 1;")).toMatchObject({
			ok: false,
			error: { kind: "sandbox", message: "observer failed" },
		});
		await Promise.all(exited);
		expect(reservations).toBe(0);
	} finally {
		await sandbox.close();
	}
	const failed = new CodemodeSandbox({ wasm: Promise.reject(new Error("wasm unavailable")) });
	try {
		expect(await failed.execute("return 1;")).toMatchObject({
			ok: false,
			error: { kind: "sandbox", message: expect.stringContaining("Failed to load QuickJS") },
		});
	} finally {
		await failed.close();
	}
});

test("remote output batching retains every output item in order across count and byte limits", async () => {
	const sizes: number[] = [];
	const sandbox = new RemoteCodemodeSandbox({
		remote: () => ({
			execute: (request, exchange) =>
				serveCodemodeRemote(
					request,
					async (messages) => {
						sizes.push(messages.length);
						return exchange(messages);
					},
					{ wasm: loadQuickJSWasm() },
				),
		}),
	});
	try {
		const result = await sandbox.execute('for (let i=0;i<2001;i++) text(i); text("x".repeat(1048576)); return 2001;');
		expect(result).toMatchObject({ ok: true, value: 2001 });
		expect(result.output).toHaveLength(2002);
		expect(result.output.slice(0, 2001)).toEqual(
			Array.from({ length: 2001 }, (_, index) => ({ type: "text", text: String(index) })),
		);
		expect(result.output.at(-1)).toEqual({ type: "text", text: "x".repeat(1048576) });
		expect(sizes.filter((size) => size === 1000)).toHaveLength(2);
	} finally {
		await sandbox.close();
	}
});
