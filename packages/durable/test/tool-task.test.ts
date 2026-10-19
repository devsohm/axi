import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, Type } from "@axi/ai";
import { BACKGROUND_CONTEXT as context, awaitWithContext } from "@axi/chord/context";
import { afterEach, describe, expect, it } from "vitest";
import { AssistantEntry, defineTask, defineTool, LiveDoc, ToolTask, ToolResultEntry, UsageDoc } from "../src/index.ts";
import type { ToolTaskResult } from "../src/harness/tool.ts";
import type { Extension, ToolExecutionApi, ToolRegistration } from "../src/harness/types.ts";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import type { JsonObject, Storage, TaskId } from "../src/types.ts";
import { agent, closeSchedulers, open, root } from "./scheduler-support.ts";

const directories: string[] = [];
afterEach(async () => {
	await closeSchedulers();
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function openTools(
	tools: readonly ToolRegistration[],
	options: { storage?: Storage; extensions?: readonly Extension[] } = {},
) {
	const opened = await open([ToolTask], {
		storage: options.storage,
		agent: async () => ({
			...agent,
			tools,
			callable: tools,
			extensions: options.extensions ?? [{ name: "tools", tools }],
		}),
	});
	return { ...opened, conversation: await root(opened.session) };
}
async function call(opened: Awaited<ReturnType<typeof openTools>>, name: string, args: JsonObject) {
	return opened.session.commit(async (tx) => {
		const message = fauxAssistantMessage([fauxToolCall(name, args, { id: "call" })], { stopReason: "toolUse" });
		const entry = await tx.appendEntry(AssistantEntry, opened.conversation, { model: [message] });
		const id = await tx.createTask(
			ToolTask,
			{ kind: "model", assistant: entry.id, callId: "call" },
			{ ownership: { kind: "conversation" }, conversationId: opened.conversation },
		);
		(await tx.doc(LiveDoc, opened.conversation)).tools = [{ callId: "call", name, taskId: id, status: "pending" }];
		return id;
	}, context);
}
async function result(opened: Awaited<ReturnType<typeof openTools>>, id: TaskId<ToolTaskResult>) {
	const task = await opened.scheduler.waitForTask(id, context),
		page = await opened.storage.scanEntries({ conversationId: opened.conversation }, 100, undefined, context);
	const entry = page.items.find((entry) => ToolResultEntry.is(entry) && entry.byTaskId === id);
	return { task, entry, message: entry?.model?.[0] };
}
const parameters = Type.Object({ text: Type.String() });
const textTool = (
	execute: ToolRegistration<typeof parameters>["execute"],
	extra: Partial<ToolRegistration<typeof parameters>> = {},
) => defineTool({ name: "echo", description: "Echo text", parameters, execute, ...extra });
async function eventually(check: () => boolean | Promise<boolean>): Promise<void> {
	for (let count = 0; count < 300; count++) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	throw new Error("Tool did not settle");
}

describe("durable tool execution", () => {
	it("pins child restart behavior to the caller's replay policy at execution start", async () => {
		let replay: "safe" | "unsafe" = "unsafe";
		const worker = defineTask<null, { phase: "run" }, null>({
			name: "worker",
			version: 1,
			initial: () => ({ phase: "run" }),
			phases: {
				async run(_record, runtime, ctx) {
					await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx);
				},
			},
			async abort() {},
		});
		const leaf = defineTool({
			name: "leaf",
			description: "Read restart policy",
			parameters: Type.Object({}),
			async execute(_args, api, ctx) {
				return { output: [{ type: "text", text: String((await api.getTask(api.taskId, ctx))?.abandonOnRestart) }] };
			},
		});
		const parent = defineTool({
			name: "echo",
			description: "Create children",
			parameters,
			get replay() {
				return replay;
			},
			async execute(_args, api, ctx) {
				replay = "safe";
				const id = await api.createTask(worker, null, { ownership: { kind: "task", taskId: api.taskId } }, ctx);
				const child = await api.getTask(id, ctx);
				const nested = await api.executeTool("leaf", {}, ctx);
				return {
					output: [
						{
							type: "text",
							text: JSON.stringify({ worker: child?.abandonOnRestart, nested: nested.structuredOutput }),
						},
					],
				};
			},
		});
		const opened = await openTools([parent, leaf]);
		opened.registry.replace([ToolTask, worker]);
		const id = await call(opened, "echo", { text: "x" });
		opened.scheduler.resume();
		expect((await result(opened, id)).message).toMatchObject({
			content: [{ type: "text", text: '{"worker":true,"nested":"true"}' }],
		});
	});
	it("records intent, streams details and output, and appends its result with the task identity", async () => {
		const entered = Promise.withResolvers<void>(),
			release = Promise.withResolvers<void>();
		let retainedApi: ToolExecutionApi | undefined;
		const tool = textTool(async (args, api, ctx) => {
			retainedApi = api;
			api.output(`value ${args.text}`);
			await api.details({ step: 1 }, ctx);
			api.diagnostic({ severity: "info", message: "reported" });
			entered.resolve();
			await awaitWithContext(release.promise, ctx);
			return {};
		});
		const opened = await openTools([tool]),
			id = await call(opened, "echo", { text: "hello" });
		opened.scheduler.resume();
		await entered.promise;
		expect((await opened.storage.task(id, context))?.state).toEqual({
			status: "running",
			checkpoint: { phase: "execute", arguments: { text: "hello" }, replay: "unsafe" },
		});
		expect((await opened.session.snapshot(LiveDoc, opened.conversation, context))?.tools?.[0]).toMatchObject({
			output: "value hello",
			details: { step: 1 },
			status: "running",
		});
		release.resolve();
		const settled = await result(opened, id);
		expect(settled.task.state.outcome.status).toBe("completed");
		expect(settled.message).toMatchObject({
			role: "toolResult",
			toolCallId: "call",
			toolName: "echo",
			isError: false,
			content: [
				{ type: "text", text: "value hello" },
				{ type: "text", text: "<harness>\n[info] reported\n</harness>" },
			],
			details: { step: 1 },
		});
		expect(() => retainedApi!.output("late")).toThrow("has settled");
	});
	it("preserves streamed output when execution throws and records failure", async () => {
		const tool = textTool(async (_args, api) => {
			api.output("partial");
			throw new Error("cannot finish");
		});
		const opened = await openTools([tool]),
			id = await call(opened, "echo", { text: "x" });
		opened.scheduler.resume();
		const settled = await result(opened, id);
		expect(settled.task.state.outcome).toMatchObject({ status: "failed", error: { message: "Tool echo threw" } });
		expect(settled.message).toMatchObject({
			role: "toolResult",
			isError: true,
			content: [
				{ type: "text", text: "partial" },
				{ type: "text", text: "<harness>\n[error] cannot finish\n</harness>" },
			],
		});
	});
	it("repairs and validates arguments before hooks, then applies the final result hook", async () => {
		const values: string[] = [];
		const tool = textTool(
			async (args) => {
				values.push(args.text);
				return { output: [{ type: "text", text: args.text }] };
			},
			{ prepareArguments: (args) => ({ text: String((args as { value: unknown }).value) }) },
		);
		const handlers = {
			beforeTool(call: { arguments: JsonObject }) {
				expect(call.arguments).toEqual({ text: "7" });
				return { arguments: { text: "changed" } };
			},
			afterTool() {
				return { output: [{ type: "text" as const, text: "replaced" }], control: { addTools: ["other"] } };
			},
		};
		const opened = await openTools([tool], {
				extensions: [{ name: "hook", hooks: [{ task: ToolTask.definition.name, handlers }] }],
			}),
			id = await call(opened, "echo", { value: 7 });
		opened.scheduler.resume();
		const settled = await result(opened, id);
		expect(values).toEqual(["changed"]);
		expect(settled.message).toMatchObject({ role: "toolResult", content: [{ type: "text", text: "replaced" }] });
		expect(settled.task.state.outcome).toMatchObject({
			status: "completed",
			result: { kind: "model", control: { addTools: ["other"] } },
		});
	});
	it("bounds explicit output and reports malformed structured output to the extension owner", async () => {
		const tool = textTool(
			async () => ({ output: [{ type: "text", text: "abcdef" }], structuredOutput: { count: "wrong" } }),
			{ outputLimits: { maxBytes: 3 }, structuredOutputSchema: Type.Object({ count: Type.Number() }) },
		);
		const opened = await openTools([tool]),
			id = await call(opened, "echo", { text: "x" });
		opened.scheduler.resume();
		const settled = await result(opened, id);
		expect(settled.message).toMatchObject({
			role: "toolResult",
			isError: false,
			content: [
				{ type: "text", text: "abc" },
				{
					type: "text",
					text: "<harness>\n[warn] Output truncated to its beginning: 0 lines, 3 bytes dropped\n</harness>",
				},
			],
		});
		expect(opened.reports).toHaveLength(1);
		expect(opened.reports[0]?.info).toMatchObject({ type: "extension_error", extension: "tools" });
	});
	it("reattaches repeated nested keys, returns independent values and rejects conflicting arguments", async () => {
		let runs = 0;
		const leaf = defineTool({
			name: "leaf",
			description: "Count",
			parameters: Type.Object({ n: Type.Number() }),
			structuredOutputSchema: Type.Object({ count: Type.Number() }),
			execute: async (args) => {
				runs++;
				return { structuredOutput: { count: args.n }, output: [] };
			},
		});
		const parent = textTool(
			async (_args, api, ctx) => {
				const first = await api.executeTool("leaf", { n: 3 }, ctx, { key: "chosen" });
				(first.structuredOutput as { count: number }).count = 99;
				const second = await api.executeTool("leaf", { n: 3 }, ctx, { key: "chosen" });
				expect(second.structuredOutput).toEqual({ count: 3 });
				await expect(api.executeTool("leaf", { n: 4 }, ctx, { key: "chosen" })).rejects.toThrow(
					"was already made with another tool or other arguments",
				);
				await expect(api.executeTool("leaf", { n: 3 }, ctx, { key: "__proto__" })).rejects.toThrow("must be non-empty");
				return { output: [{ type: "text", text: String((second.structuredOutput as { count: number }).count) }] };
			},
			{ replay: "safe" },
		);
		const opened = await openTools([parent, leaf]),
			id = await call(opened, "echo", { text: "x" });
		opened.scheduler.resume();
		const settled = await result(opened, id);
		expect(runs).toBe(1);
		expect(settled.message).toMatchObject({ role: "toolResult", content: [{ type: "text", text: "3" }] });
		expect((await opened.session.snapshot(LiveDoc, opened.conversation, context))?.nestedTools).toBeUndefined();
	});
	it.each(["safe", "unsafe"] as const)("recovers %s tool intent after a clean close", async (replay) => {
		const directory = await mkdtemp(join(tmpdir(), "axi-tool-"));
		directories.push(directory);
		const path = join(directory, "session.sqlite");
		let attempts = 0,
			finish = false;
		const tool = textTool(
			async (_args, api, ctx) => {
				attempts++;
				await api.memo("effect", "stable", ctx);
				if (!finish) await awaitWithContext(new Promise<void>(() => {}), ctx);
				return { output: [{ type: "text", text: "finished" }] };
			},
			{ replay },
		);
		const first = await openTools([tool], { storage: await openNodeSqliteStorage(path) }),
			id = await call(first, "echo", { text: "x" });
		first.scheduler.resume();
		await eventually(() => attempts === 1);
		await first.session.close(context);
		finish = true;
		const second = await openTools([tool], { storage: await openNodeSqliteStorage(path) });
		second.conversation = first.conversation;
		second.scheduler.resume();
		const settled = await result(second, id);
		expect(attempts).toBe(replay === "safe" ? 2 : 1);
		expect(settled.task.state.outcome.status).toBe(replay === "safe" ? "completed" : "failed");
		if (replay === "unsafe")
			expect(settled.message).toMatchObject({
				role: "toolResult",
				isError: true,
				content: [
					{ type: "text", text: "<harness>\n[error] Tool echo was interrupted and may have partially run\n</harness>" },
				],
			});
	});
	it("adds tool usage with the result's entry", async () => {
		const usage = {
			input: 1,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 3,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const tool = textTool(async () => ({ usage, output: [] }));
		const opened = await openTools([tool]),
			id = await call(opened, "echo", { text: "x" });
		opened.scheduler.resume();
		await result(opened, id);
		expect(await opened.session.snapshot(UsageDoc, opened.conversation, context)).toEqual({
			models: {},
			tools: { echo: usage },
		});
	});
});
