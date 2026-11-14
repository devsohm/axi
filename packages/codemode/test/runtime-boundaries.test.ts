import { expect, test } from "vitest";
import {
	CodemodeSandbox,
	InlineCodemodeSandbox,
	loadQuickJSWasm,
	serveCodemodeRemote,
	type CodemodeRemoteMessage,
} from "../src/index.ts";
import { describeError, errorMessage, scriptException } from "../src/errors.ts";
import { inlineLauncher } from "../src/runtime/inline.ts";
import { isWorkerToHostMessage } from "../src/runtime/protocol.ts";
import { quietOutput } from "../src/runtime/wasi.ts";

test.each([
	{ input: new Error("Unavailable"), message: "Unavailable", description: "Error: Unavailable" },
	{ input: "Unavailable", message: "Unavailable", description: "Unavailable" },
])(
	"runtime diagnostics retain the message and optional exception name for $description",
	({ input, message, description }) => {
		expect(errorMessage(input)).toBe(message);
		expect(describeError(input)).toBe(description);
	},
);

test("discarded WASI writes acknowledge their byte count after memory growth", () => {
	const memory = new WebAssembly.Memory({ initial: 1 });
	const output = quietOutput(memory);
	let view = new DataView(memory.buffer);
	view.setUint32(0, 100, true);
	view.setUint32(4, 3, true);
	view.setUint32(8, 103, true);
	view.setUint32(12, 5, true);
	expect(output.fd_write(1, 0, 2, 32)).toBe(0);
	expect(view.getUint32(32, true)).toBe(8);
	expect(output.fd_write(2, 0, 0, 32)).toBe(0);
	expect(view.getUint32(32, true)).toBe(0);
	memory.grow(1);
	view = new DataView(memory.buffer);
	view.setUint32(65536, 100, true);
	view.setUint32(65540, 4, true);
	expect(output.fd_write(1, 65536, 1, 65544)).toBe(0);
	expect(view.getUint32(65544, true)).toBe(4);
});

test("script diagnostics preserve absent or empty stacks and empty messages", () => {
	expect(
		JSON.parse(scriptException({ name: "SyntaxError", message: "Unexpected token", stack: "at code.js:2\n" })),
	).toEqual({
		name: "SyntaxError",
		message: "Unexpected token",
		stack: "SyntaxError: Unexpected token\nat code.js:2",
	});
	expect(JSON.parse(scriptException({ name: "SyntaxError", message: "", stack: "" }))).toEqual({
		name: "SyntaxError",
		message: "",
		stack: "SyntaxError",
	});
	expect(JSON.parse(scriptException({ name: "Error", message: "Failed" }))).toEqual({
		name: "Error",
		message: "Failed",
		stack: "Error: Failed",
	});
});

test("an inline channel ignores a host response arriving after shutdown", async () => {
	const messages: unknown[] = [];
	const channel = await inlineLauncher(loadQuickJSWasm())(
		{
			code: "return await tools.answer();",
			tools: [{ name: "answer", jsName: "answer", description: "Return an answer" }],
			globals: [],
			store: {},
			memoryLimitBytes: undefined,
		},
		{
			message: (value) => messages.push(value),
			failure: (error) => {
				throw new Error(error.message);
			},
		},
	);
	try {
		const call = messages.filter(isWorkerToHostMessage).find((message) => message.type === "call");
		if (call?.type !== "call") throw new Error("Missing host call");
		await channel.stop();
		const before = structuredClone(messages);
		channel.post({ type: "result", id: call.id, ok: true, payload: "42" });
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(messages).toEqual(before);
	} finally {
		await channel.stop();
	}
});

test.each(["inline", "worker"] as const)(
	"a completed %s result survives a later native cleanup failure",
	async (mode) => {
		const sandbox = mode === "inline" ? new InlineCodemodeSandbox({ wasm: loadQuickJSWasm() }) : new CodemodeSandbox();
		try {
			expect(
				await sandbox.execute(`
Promise.resolve().then(() => {
  globalThis.registry = new FinalizationRegistry(() => { throw new Error("Cleanup failed"); });
  for (let i = 0; i < 10; i++) registry.register({}, 1);
});
store("answer", 42);
return 42;`),
			).toMatchObject({ ok: true, value: 42, storeWrites: { set: { answer: 42 }, delete: [] } });
		} finally {
			await sandbox.close();
		}
	},
);

test("the remote service delivers an immediate tool response and completes its script", async () => {
	const messages: CodemodeRemoteMessage[] = [];
	await serveCodemodeRemote(
		{
			data: {
				code: "return await tools.answer();",
				tools: [{ name: "answer", jsName: "answer", description: "Return an answer" }],
				globals: [],
				store: {},
				memoryLimitBytes: undefined,
			},
		},
		async (batch) => {
			messages.push(...batch);
			const call = batch.find((message) => message.type === "call");
			return call?.type === "call" ? { type: "result", id: call.id, ok: true, payload: "42" } : null;
		},
		{ wasm: loadQuickJSWasm() },
	);
	expect(messages.filter((message) => message.type === "call")).toMatchObject([{ name: "answer" }]);
	expect(messages.filter((message) => message.type === "done")).toMatchObject([{ ok: true, value: "42" }]);
});

test("concurrent failed output exchanges still release the remote service", async () => {
	const batches: CodemodeRemoteMessage[][] = [];
	await serveCodemodeRemote(
		{
			data: {
				code: "for (let i = 0; i < 3000; i++) text(i); return 42;",
				tools: [],
				globals: [],
				store: {},
				memoryLimitBytes: undefined,
			},
		},
		async (batch) => {
			batches.push(batch);
			throw new Error("Remote connection lost");
		},
		{ wasm: loadQuickJSWasm() },
	);
	expect(batches.map((batch) => batch.filter((message) => message.type === "output").length).filter(Boolean)).toEqual([
		1000, 1000, 1000,
	]);
	expect(batches.flat().filter((message) => message.type === "done")).toMatchObject([{ ok: true, value: "42" }]);
});

test.each(["inline", "worker"] as const)(
	"a failed native cleanup job settles the %s sandbox without publishing writes",
	async (mode) => {
		const sandbox = mode === "inline" ? new InlineCodemodeSandbox({ wasm: loadQuickJSWasm() }) : new CodemodeSandbox();
		try {
			const result = await sandbox.execute(`
store("pending", 42);
const registry = new FinalizationRegistry(() => { throw new Error("Cleanup failed"); });
for (let i = 0; i < 10; i++) registry.register({}, 1);
await Promise.resolve();
return 42;`);
			expect(result).toMatchObject({
				ok: false,
				error: { kind: "sandbox", message: expect.stringContaining("Promise job failed") },
			});
			expect("storeWrites" in result).toBe(false);
			expect(await sandbox.execute("return 42;")).toMatchObject({ ok: true, value: 42 });
		} finally {
			await sandbox.close();
		}
	},
);
