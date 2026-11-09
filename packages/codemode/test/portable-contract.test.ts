import { expect, test } from "vitest";
import { InlineCodemodeSandbox, RemoteCodemodeSandbox, loadQuickJSWasm, serveCodemodeRemote } from "../src/index.ts";

for (const location of ["inline", "remote"] as const) {
	test(`${location} execution separates VM values from host objects and commits only successful store writes`, async () => {
		const executions: Promise<void>[] = [];
		const inputs: unknown[] = [];
		const tools = [
			{
				name: "double",
				execute(value: unknown) {
					inputs.push(value);
					if (typeof value !== "number") throw new Error("number required");
					return { answer: value * 2 };
				},
			},
		];
		const sandbox =
			location === "inline"
				? new InlineCodemodeSandbox({ wasm: loadQuickJSWasm(), tools })
				: new RemoteCodemodeSandbox({
						tools,
						remote: () => ({
							execute(request, exchange) {
								const done = serveCodemodeRemote(
									structuredClone(request),
									async (messages) => structuredClone(await exchange(structuredClone(messages))),
									{ wasm: loadQuickJSWasm() },
								);
								executions.push(done);
								return done;
							},
						}),
					});
		try {
			const result = await sandbox.execute(
				'const answer = await tools.double(21); store("answer", answer); text(answer); return load("answer");',
			);
			expect(result).toMatchObject({
				ok: true,
				value: { answer: 42 },
				output: [{ type: "text", text: '{"answer":42}' }],
				calls: [{ name: "double", status: "ok" }],
				storeWrites: { set: { answer: { answer: 42 } }, delete: [] },
			});
			expect(inputs).toEqual([21]);
			expect(await sandbox.execute('store("answer", 99); throw new Error("discard");')).toMatchObject({
				ok: false,
				error: { kind: "script", message: "discard" },
			});
			expect(await sandbox.execute('return [typeof process, typeof fetch, load("answer")];')).toMatchObject({
				ok: true,
				value: ["undefined", "undefined", null],
			});
		} finally {
			await sandbox.close();
			await Promise.all(executions);
		}
	});
}

test("a remote execution obeys the server computation cap and exposes transport failures as sandbox errors", async () => {
	const work: Promise<void>[] = [];
	const limited = new RemoteCodemodeSandbox({
		interruptBudget: 1000000,
		remote: () => ({
			execute(request, exchange) {
				const done = serveCodemodeRemote(request, exchange, { wasm: loadQuickJSWasm(), maxInterruptBudget: 20 });
				work.push(done);
				return done;
			},
		}),
	});
	try {
		expect(await limited.execute("while (true) {}", { timeoutMs: 10000 })).toMatchObject({
			ok: false,
			error: { kind: "timeout", message: expect.stringContaining("20") },
		});
	} finally {
		await limited.close();
		await Promise.all(work);
	}
	const broken = new RemoteCodemodeSandbox({
		remote: () => ({
			async execute() {
				throw new Error("remote disconnected");
			},
		}),
	});
	try {
		expect(await broken.execute("return 42;")).toMatchObject({
			ok: false,
			error: { kind: "sandbox", message: "Remote sandbox failed: remote disconnected" },
		});
	} finally {
		await broken.close();
	}
});

test.each([undefined, 4 * 1024 * 1024, 16 * 1024 * 1024])(
	"remote memory caps apply to a requested heap of %s bytes",
	async (memoryLimitBytes) => {
		const work: Promise<void>[] = [],
			cap = 8 * 1024 * 1024;
		const sandbox = new RemoteCodemodeSandbox({
			memoryLimitBytes,
			remote: () => ({
				execute(request, exchange) {
					const execution = serveCodemodeRemote(request, exchange, {
						wasm: loadQuickJSWasm(),
						maxMemoryLimitBytes: cap,
					});
					work.push(execution);
					return execution;
				},
			}),
		});
		try {
			const result = await sandbox.execute("return 'x'.repeat(32 * 1024 * 1024);");
			expect(result).toMatchObject({ ok: false, error: { kind: "script", message: expect.stringMatching(/memory/i) } });
			expect(await sandbox.execute("return 42;")).toMatchObject({ ok: true, value: 42 });
		} finally {
			await sandbox.close();
			await Promise.all(work);
		}
	},
);

test("remote output batches flush before the final result without dropping or repeating text", async () => {
	const work: Promise<void>[] = [],
		batches: number[] = [];
	const sandbox = new RemoteCodemodeSandbox({
		remote: () => ({
			execute(request, exchange) {
				const execution = serveCodemodeRemote(
					request,
					async (messages) => {
						batches.push(messages.filter((message) => message.type === "output").length);
						return exchange(messages);
					},
					{ wasm: loadQuickJSWasm() },
				);
				work.push(execution);
				return execution;
			},
		}),
	});
	try {
		const result = await sandbox.execute("for(let i = 0; i < 1001; i++) text(String(i)); return 42;");
		expect(result).toMatchObject({ ok: true, value: 42 });
		expect(result.output).toEqual(Array.from({ length: 1001 }, (_, index) => ({ type: "text", text: String(index) })));
		expect(batches.reduce((sum, count) => sum + count, 0)).toBe(1001);
		expect(batches.some((count) => count >= 999)).toBe(true);
	} finally {
		await sandbox.close();
		await Promise.all(work);
	}
});

test("a remote server releases its VM after its exchange rejects a host call", async () => {
	const received: string[] = [];
	await serveCodemodeRemote(
		{
			data: {
				code: "return await tools.wait();",
				tools: [{ name: "wait", jsName: "wait", description: "Await a host result" }],
				globals: [],
				memoryLimitBytes: undefined,
				store: {},
			},
		},
		async (messages) => {
			received.push(...messages.map((message) => message.type));
			throw new Error("Exchange disconnected");
		},
		{ wasm: loadQuickJSWasm() },
	);
	expect(received).toContain("call");
	expect(received).not.toContain("done");
});
