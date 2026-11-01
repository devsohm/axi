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
