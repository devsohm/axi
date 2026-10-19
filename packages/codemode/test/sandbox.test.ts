import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import {
	CodemodeSandbox,
	CodemodeSandboxBase,
	InlineCodemodeSandbox,
	RemoteCodemodeSandbox,
	loadQuickJSWasm,
	serveCodemodeRemote,
	parseCodemodeSource,
	renderDeclarations,
	renderToolSample,
	schemaToType,
	type CodemodeRun,
	type CodemodeResult,
	type CodemodeRunOptions,
	type RemoteCodemodeSandboxOptions,
} from "../src/index.ts";

describe("Code Mode", () => {
	it.each([null, 7, "invalid", []])(
		"ignores non-schema reference targets without spending the expansion budget: %j",
		(invalid) => {
			const schema = {
				$defs: { invalid, valid: { type: "string" } },
				type: "object",
				properties: {
					...Object.fromEntries(
						Array.from({ length: 32 }, (_, index) => [`ignored${index}`, { $ref: "#/$defs/invalid" }]),
					),
					result: { $ref: "#/$defs/valid" },
				},
			};
			expect(schemaToType(schema)).toMatch(/ result\?: string; }$/);
		},
	);
	it("exposes the built-in override accessors with stable names", async () => {
		const sandbox = new InlineCodemodeSandbox({ wasm: loadQuickJSWasm() });
		try {
			expect(
				await sandbox.execute(
					'const d=Object.getOwnPropertyDescriptor(Error.prototype,"name"); return [d.get.name,d.set.name,d.enumerable,d.configurable];',
				),
			).toEqual({
				ok: true,
				value: ["get accessor", "set accessor", false, false],
				output: [],
				calls: [],
				storeWrites: { set: {}, delete: [] },
			});
		} finally {
			await sandbox.close();
		}
	});
	it.each(["execute", "start"] as const)("serializes the %s launcher packet in protocol order", async (mode) => {
		const sandbox = new CodemodeSandboxBase(
			{
				memoryLimitBytes: 4096,
				tools: [{ name: "read-file", description: "Read file", execute() {} }],
				globals: [{ name: "format", spread: true, execute() {} }],
			},
			(data, events) => {
				events.message({ type: "done", ok: true, value: JSON.stringify(JSON.stringify(data)), writes: "[]" });
				return { post() {}, async stop() {} };
			},
		);
		try {
			const result =
				mode === "execute"
					? await sandbox.execute("return 1", { store: { key: { a: 1 } } })
					: await sandbox.start("return 1", {
							startedAt: 100,
							seed: 1,
							tools: [{ name: "read-file", description: "Read file" }],
							globals: [{ name: "format", spread: true }],
							store: { key: { a: 1 } },
							onCall() {},
						}).result;
			expect(result).toEqual({
				ok: true,
				value:
					'{"code":"return 1","tools":[{"name":"read-file","jsName":"read_file","description":"Read file"}],"globals":[{"name":"format","spread":true}],"memoryLimitBytes":4096,"store":{"key":"{\\"a\\":1}"}' +
					(mode === "start" ? ',"deterministic":{"startedAt":100,"seed":1}}' : "}"),
				output: [],
				calls: [],
				storeWrites: { set: {}, delete: [] },
			});
		} finally {
			await sandbox.close();
		}
	});
	it("publishes store helpers before the remaining script globals", async () => {
		const sandbox = new InlineCodemodeSandbox({ wasm: loadQuickJSWasm() });
		try {
			const result = await sandbox.execute(
				'return Object.keys(globalThis).filter(name => ["store", "load", "tools", "ALL_TOOLS", "console", "text", "image", "exit"].includes(name));',
			);
			expect(result).toMatchObject({
				ok: true,
				value: ["store", "load", "tools", "ALL_TOOLS", "console", "text", "image", "exit"],
			});
		} finally {
			await sandbox.close();
		}
	});
	it("copies inherited script error details once", async () => {
		const previous = Object.getOwnPropertyDescriptor(Object.prototype, "name");
		let reads = 0;
		const sandbox = new CodemodeSandboxBase({}, (_data, events) => {
			events.message({ type: "done", ok: false, error: '{"message":"failure"}' });
			return { post() {}, async stop() {} };
		});
		let result;
		try {
			Object.defineProperty(Object.prototype, "name", { configurable: true, get: () => `Name${++reads}` });
			result = await sandbox.execute("");
		} finally {
			if (previous) Object.defineProperty(Object.prototype, "name", previous);
			else Reflect.deleteProperty(Object.prototype, "name");
			await sandbox.close();
		}
		expect(reads).toBe(1);
		expect(result).toEqual({
			ok: false,
			error: { kind: "script", name: "Name1", message: "failure", stack: undefined },
			output: [],
			calls: [],
		});
	});
	it("dispatches bridge targets consistently and preserves result field order", async () => {
		for (const target of ["other", "__proto__"]) {
			const sandbox = new CodemodeSandboxBase({ globals: [{ name: "answer", execute: () => 42 }] }, (_data, events) => {
				queueMicrotask(() => events.message({ type: "call", id: 1, target, name: "answer" }));
				return {
					post(message) {
						events.message({ type: "done", ok: true, value: JSON.stringify(message), writes: "[]" });
					},
					async stop() {},
				};
			});
			try {
				const result = await sandbox.execute("");
				expect(result).toMatchObject({ ok: true, value: { type: "result", id: 1, ok: true, payload: "42" } });
				expect(Object.keys(result)).toEqual(["ok", "value", "output", "calls", "storeWrites"]);
			} finally {
				await sandbox.close();
			}
		}
	});
	it("validates tool names before reading deterministic globals", () => {
		const sandbox = new CodemodeSandboxBase({}, () => {
			throw new Error("Unexpected launch");
		});
		expect(() =>
			sandbox.start("", {
				startedAt: 1,
				seed: 1,
				tools: [{ name: "same" }, { name: "same" }],
				get globals(): never {
					throw new Error("Unexpected globals read");
				},
				onCall() {},
			}),
		).toThrow("Tool names must be unique");
	});
	it("captures the tool list and renders a sample signature before reading its description", () => {
		let reads = 0;
		expect(
			renderDeclarations({
				get tools() {
					if (++reads > 1) throw new Error("Tool list was read again");
					return [{ name: "read", execute() {} }];
				},
			}),
		).toBe("declare const tools: {\n  read(args: unknown): Promise<unknown>;\n};");
		const tool = {
			name: "original",
			get description() {
				this.name = "changed";
				return "Read a value";
			},
		};
		expect(renderToolSample(tool)).toBe(
			"Read a value\n\ncodemode tool declaration:\n```ts\ndeclare const tools: { original(args: unknown): Promise<unknown>; };\n```",
		);
	});
	it("captures a schema type and its description at their defined read points", () => {
		let typeReads = 0;
		expect(
			schemaToType({
				get type() {
					return ++typeReads === 1 ? "string" : "number";
				},
			}),
		).toBe("string");
		let descriptionReads = 0;
		expect(
			schemaToType({
				type: "object",
				properties: {
					value: {
						type: "string",
						get description() {
							return ++descriptionReads === 1 ? "first" : "second";
						},
					},
				},
			}),
		).toBe("{\n  // first\n  value?: string;\n}");
	});
	it("captures an inherited source option once", () => {
		const previous = Object.getOwnPropertyDescriptor(Object.prototype, "timeout_ms");
		let reads = 0;
		let parsed;
		try {
			Object.defineProperty(Object.prototype, "timeout_ms", { configurable: true, get: () => ++reads });
			parsed = parseCodemodeSource("// @options: {}\nreturn 1;");
		} finally {
			if (previous) Object.defineProperty(Object.prototype, "timeout_ms", previous);
			else Reflect.deleteProperty(Object.prototype, "timeout_ms");
		}
		expect(reads).toBe(1);
		expect(parsed).toEqual({ code: "\nreturn 1;", options: { timeoutMs: 1 } });
	});
	it("retains only declared result position fields from the VM", async () => {
		const sandbox = new CodemodeSandboxBase({}, (_data, events) => {
			events.message({ type: "done", ok: true, writes: "[]", during: { seq: 0, issued: 0, extra: "discard" } });
			return { post() {}, async stop() {} };
		});
		try {
			expect((await sandbox.execute("")).during).toEqual({ seq: 0, issued: 0 });
		} finally {
			await sandbox.close();
		}
	});
	it("samples one end time when cancelling pending calls", async () => {
		let now = 0;
		const clock = vi.spyOn(performance, "now").mockImplementation(() => ++now);
		const sandbox = new CodemodeSandboxBase(
			{ tools: [{ name: "wait", execute: () => new Promise(() => {}) }] },
			(_data, events) => {
				for (const id of [1, 2]) events.message({ type: "call", id, target: "tool", name: "wait" });
				return { post() {}, async stop() {} };
			},
		);
		try {
			const result = sandbox.execute("");
			await sandbox.close();
			expect((await result).calls.map((call) => call.durationMs)).toEqual([2, 1]);
		} finally {
			clock.mockRestore();
			await sandbox.close();
		}
	});
	it("releases run declarations while a finished run remains retained", () => {
		const module = new URL("../src/runtime/execution.ts", import.meta.url).href;
		const child = spawnSync(
			process.execPath,
			[
				"--expose-gc",
				"--input-type=module",
				"--eval",
				`
			import assert from "node:assert/strict";
			import {setImmediate} from "node:timers/promises";
			import {CodemodeSandboxBase} from ${JSON.stringify(module)};
			async function hold() {
				const tool = {name: "held"};
				const sandbox = new CodemodeSandboxBase({}, (_data, events) => {
					events.message({type: "done", ok: true, writes: "[]"});
					return {post() {}, async stop() {}};
				});
				const run = sandbox.start("", {startedAt: 0, seed: 0, tools: [tool], onCall() {}});
				await run.result;
				await sandbox.close();
				return {run, root: new WeakRef(tool)};
			}
			const {run, root} = await hold();
			for (let i = 0; i < 16; i++) {await setImmediate(); globalThis.gc();}
			assert.equal(root.deref(), undefined);
			assert.equal(run.finished, true);
		`,
			],
			{ encoding: "utf8", timeout: 10000 },
		);
		expect(child.status, child.stderr).toBe(0);
	});
	it("retains the WebAssembly compiler selected when loading starts", async () => {
		const compiler = globalThis.WebAssembly;
		const path = createRequire(import.meta.url)
			.resolve("quickjs-wasi/quickjs.wasm")
			.replace(/\/([^/]+)$/, "/./$1");
		const pending = loadQuickJSWasm(path);
		globalThis.WebAssembly = new Proxy(compiler, {
			get(target, key, receiver) {
				if (key === "compile")
					return () => {
						throw new Error("replacement compiler");
					};
				return Reflect.get(target, key, receiver);
			},
		});
		try {
			expect(await pending).toBeInstanceOf(compiler.Module);
		} finally {
			globalThis.WebAssembly = compiler;
		}
	});
	it("keeps the admitted tool registry when reading a description changes registration", async () => {
		const sandbox = new InlineCodemodeSandbox({ wasm: loadQuickJSWasm() });
		sandbox.registerTool({
			name: "answer",
			get description() {
				sandbox.unregisterTool("answer");
				return "Return the answer";
			},
			execute: () => 42,
		});
		try {
			expect(await sandbox.execute("return await tools.answer()")).toMatchObject({ ok: true, value: 42 });
			expect(sandbox.tools).toEqual([]);
		} finally {
			await sandbox.close();
		}
	});
	it("does not read tool descriptions after a deterministic run was already aborted", async () => {
		const sandbox = new InlineCodemodeSandbox({ wasm: loadQuickJSWasm() });
		let reads = 0;
		try {
			const run = sandbox.start("return await tools.answer()", {
				startedAt: 1000,
				seed: 7,
				signal: AbortSignal.abort(),
				tools: [
					{
						name: "answer",
						get description(): string {
							reads++;
							throw new Error("description should remain unread");
						},
					},
				],
				onCall() {
					throw new Error("An aborted run must not call tools");
				},
			});
			expect(await run.result).toMatchObject({ ok: false, error: { kind: "aborted" } });
			expect(reads).toBe(0);
		} finally {
			await sandbox.close();
		}
	});
	it("interrupts when the computation budget is NaN", async () => {
		const sandbox = new InlineCodemodeSandbox({ wasm: loadQuickJSWasm(), interruptBudget: NaN });
		try {
			expect(await sandbox.execute("let total=0; for(let i=0;i<100000;i++)total+=i; return total;")).toMatchObject({
				ok: false,
				error: { kind: "timeout", message: "Execution exceeded its interrupt budget of NaN" },
				output: [],
				calls: [],
			});
		} finally {
			await sandbox.close();
		}
	});
	it("rejects malformed remote call arguments before recording a call", async () => {
		const sandbox = new RemoteCodemodeSandbox({
			remote: () => ({
				async execute(_request, exchange) {
					await exchange([{ type: "call", target: "tool", name: "read", id: 1, args: "{" }]);
				},
			}),
		});
		try {
			const run = sandbox.start("return await tools.read()", {
				startedAt: 1000,
				seed: 7,
				tools: [{ name: "read" }],
				onCall() {
					throw new Error("Malformed arguments reached the caller");
				},
			});
			expect(await run.result).toMatchObject({
				ok: false,
				error: {
					kind: "sandbox",
					message:
						"Sandbox bridge broken: call arguments is not valid JSON. The script may have modified built-ins such as a prototype's toJSON.",
				},
				calls: [],
			});
		} finally {
			await sandbox.close();
		}
	});
	it("keeps the remote endpoint and budget selected at construction", async () => {
		const requests: { endpoint: string; budget: number | undefined }[] = [];
		const endpoint =
			(name: string): RemoteCodemodeSandboxOptions["remote"] =>
			() => ({
				execute(request, exchange) {
					requests.push({ endpoint: name, budget: request.interruptBudget });
					return serveCodemodeRemote(request, exchange, { wasm: loadQuickJSWasm() });
				},
			});
		const options: RemoteCodemodeSandboxOptions = { remote: endpoint("initial"), interruptBudget: 1000 };
		const sandbox = new RemoteCodemodeSandbox(options);
		try {
			options.remote = endpoint("changed");
			options.interruptBudget = 2000;
			expect(await sandbox.execute("return 42")).toMatchObject({ ok: true, value: 42 });
			expect(requests).toEqual([{ endpoint: "initial", budget: 1000 }]);
		} finally {
			await sandbox.close();
		}
	});
	it("keeps deterministic callbacks selected when the run starts", async () => {
		const sandbox = new InlineCodemodeSandbox({ wasm: loadQuickJSWasm() });
		try {
			let run: CodemodeRun;
			const options: CodemodeRunOptions = {
				startedAt: 1000,
				seed: 7,
				tools: [{ name: "read" }],
				onCall: (call) => queueMicrotask(() => run.deliver(1, 1001, call.id, { ok: true, value: "initial" })),
			};
			run = sandbox.start("return await tools.read()", options);
			options.onCall = (call) => queueMicrotask(() => run.deliver(1, 1001, call.id, { ok: true, value: "changed" }));
			expect(await run.result).toMatchObject({ ok: true, value: "initial" });
		} finally {
			await sandbox.close();
		}
	});
	it("serializes tool results and makes host errors catchable", async () => {
		const seen: unknown[] = [];
		const sandbox = new CodemodeSandbox({
			tools: [
				{
					name: "echo",
					execute(args) {
						seen.push(args);
						if (args === "fail") throw new Error("host refused");
						return {
							value: args,
							privateMethod() {
								return "host only";
							},
						};
					},
				},
			],
		});
		try {
			const result = await sandbox.execute(
				'text(await tools.echo("accepted")); try { await tools.echo("fail"); } catch (error) { return error.message; }',
			);
			expect(result).toMatchObject({
				ok: true,
				value: "host refused",
				output: [{ type: "text", text: '{"value":"accepted"}' }],
			});
			expect(result.calls.map((call) => call.status)).toEqual(["ok", "error"]);
			expect(seen).toEqual(["accepted", "fail"]);
		} finally {
			await sandbox.close();
		}
	});
	it("replays a recorded answer after creating a fresh sandbox", async () => {
		const repeat = async (): Promise<CodemodeResult> => {
			const sandbox = new InlineCodemodeSandbox({ wasm: loadQuickJSWasm() });
			try {
				let run: CodemodeRun;
				run = sandbox.start(
					'const x=await tools.read({clock:Date.now(),random:Math.random()}); store("x",x); return [Date.now(),performance.now(),x];',
					{
						startedAt: 5000,
						seed: 13,
						tools: [{ name: "read" }],
						onCall: (call) =>
							queueMicrotask(() => run.deliver(1, 5010, call.id, { ok: true, value: { key: "durable-answer" } })),
					},
				);
				return await run.result;
			} finally {
				await sandbox.close();
			}
		};
		for (let i = 0; i < 2; i++)
			expect(await repeat()).toMatchObject({
				ok: true,
				value: [5010, 10, { key: "durable-answer" }],
				storeWrites: { set: { x: { key: "durable-answer" } }, delete: [] },
				during: { seq: 1, issued: 1 },
			});
	});
	it("does not carry VM globals or failed store changes to another execution", async () => {
		const sandbox = new CodemodeSandbox();
		try {
			const failed = await sandbox.execute(
				'globalThis.secret=1; store("k",2); text("before"); throw new Error("stop");',
			);
			expect(failed).toMatchObject({ ok: false, output: [{ type: "text", text: "before" }] });
			expect(failed).not.toHaveProperty("storeWrites");
			expect(await sandbox.execute('return [typeof secret,load("k")];')).toMatchObject({
				ok: true,
				value: ["undefined", null],
			});
		} finally {
			await sandbox.close();
		}
	});
	it("cancels the remote tool and lets the remote release its VM", async () => {
		let entered!: () => void;
		const called = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const serving: Promise<void>[] = [];
		let signal: AbortSignal | undefined;
		const sandbox = new RemoteCodemodeSandbox({
			remote: () => ({
				execute(request, exchange) {
					const result = serveCodemodeRemote(request, exchange, { wasm: loadQuickJSWasm() });
					serving.push(result);
					return result;
				},
			}),
			tools: [
				{
					name: "pending",
					execute(_args, context) {
						signal = context.signal;
						entered();
						return new Promise(() => {});
					},
				},
			],
		});
		const result = sandbox.execute("await tools.pending()");
		await called;
		await sandbox.close();
		expect(await result).toMatchObject({
			ok: false,
			error: { kind: "aborted" },
			calls: [{ name: "pending", status: "cancelled" }],
		});
		expect(signal?.aborted).toBe(true);
		await Promise.all(serving);
	});
});
