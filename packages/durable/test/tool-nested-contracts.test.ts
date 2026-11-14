import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@axi/ai";
import { BACKGROUND_CONTEXT as context } from "@axi/objects/context";
import type { JsonValue } from "@axi/objects/json";
import { expect, test } from "vitest";
import {
	createRegistry,
	defineExtension,
	defineTask,
	defineTool,
	Harness,
	LiveDoc,
	MemoryStorage,
	ToolResultEntry,
	type Extension,
	type NestedToolExecutionResult,
	type ToolExecutionResult,
	type ToolRegistration,
} from "../src/index.ts";

async function open(tools: readonly ToolRegistration[], tasks: Extension["tasks"] = []) {
	const models = createModels(),
		provider = fauxProvider(),
		registry = createRegistry();
	models.setProvider(provider.provider);
	registry.install(defineExtension({ name: "nested", tools, tasks }));
	provider.setResponses([
		fauxAssistantMessage([fauxToolCall("parent", {}, { id: "parent-call" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("Finished"),
	]);
	const harness = await Harness.open(
		new MemoryStorage(),
		{
			models,
			registry,
			settings: { compaction: { enabled: false } },
		},
		context,
	);
	const conversation = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	return {
		harness,
		conversation,
		async run() {
			const receipt = await conversation.submit({ type: "input", content: "Run nested work" }, context);
			expect(await receipt.wait(context)).toMatchObject({ status: "done" });
			await harness.waitForIdle(context);
			expect(await harness.snapshot(LiveDoc, conversation.id, context)).toEqual({});
			const results = (await conversation.entries({}, 100, undefined, context)).items.filter(ToolResultEntry.is);
			expect(results).toHaveLength(1);
			expect(results[0]?.model?.[0]).toMatchObject({ role: "toolResult", isError: false });
		},
		async [Symbol.asyncDispose]() {
			await harness.close(context);
		},
	};
}

const image = { type: "image", data: "AQID", mimeType: "image/png" } as const;
const contents: { name: string; output: NonNullable<ToolExecutionResult["output"]>; expected: JsonValue }[] = [
	{ name: "empty", output: [], expected: "" },
	{ name: "text", output: [{ type: "text", text: "only text" }], expected: "only text" },
	{ name: "image", output: [image], expected: image },
	{
		name: "several blocks",
		output: [{ type: "text", text: "caption" }, image],
		expected: [{ type: "text", text: "caption" }, image],
	},
];
test.each(contents)("a nested tool returns $name content with progress disabled", async ({ output, expected }) => {
	let received: NestedToolExecutionResult | undefined;
	const leaf = defineTool({
		name: "leaf",
		description: "Return content",
		parameters: Type.Object({}),
		async execute(_args, api, ctx) {
			api.output("private progress");
			await api.details({ stage: 1 }, ctx);
			return { output };
		},
	});
	const parent = defineTool({
		name: "parent",
		description: "Call a tool",
		parameters: Type.Object({}),
		async execute(_args, api, ctx) {
			received = await api.executeTool("leaf", {}, ctx, { progress: false });
			return { output: [] };
		},
	});
	await using app = await open([parent, leaf]);
	await app.run();
	expect(received).toMatchObject({
		isError: false,
		structuredOutput: expected,
		details: { stage: 1 },
		diagnostics: [],
	});
});

const invalidOutputs: { name: string; result: ToolExecutionResult; code?: string }[] = [
	{ name: "missing", result: { output: [] }, code: "invalid_structured_output" },
	{ name: "wrong type", result: { output: [], structuredOutput: { count: "one" } }, code: "invalid_structured_output" },
	{ name: "null", result: { output: [], structuredOutput: null }, code: "invalid_structured_output" },
	{
		name: "error text",
		result: { isError: true, output: [{ type: "text", text: "could not finish" }] },
		code: "tool_error",
	},
	{ name: "empty error", result: { isError: true, output: [] } },
];
test.each(invalidOutputs)(
	"a nested structured tool handles $name without faulting its caller",
	async ({ result, code }) => {
		let received: NestedToolExecutionResult | undefined;
		const leaf = defineTool({
			name: "leaf",
			description: "Return a structured result",
			parameters: Type.Object({}),
			structuredOutputSchema: Type.Object({ count: Type.Number() }),
			async execute() {
				return result;
			},
		});
		const parent = defineTool({
			name: "parent",
			description: "Call a structured tool",
			parameters: Type.Object({}),
			async execute(_args, api, ctx) {
				received = await api.executeTool("leaf", {}, ctx);
				return { output: [] };
			},
		});
		await using app = await open([parent, leaf]);
		await app.run();
		expect(received?.isError).toBe(true);
		expect(received).not.toHaveProperty("structuredOutput");
		expect(received?.diagnostics.map((item) => item.code)).toEqual(code ? [code] : []);
		if (result.output?.length) expect(received?.diagnostics[0]?.message).toBe("could not finish");
	},
);

const worker = defineTask<{ value: number }, { phase: "finish" }, number>({
	name: "nested.worker",
	version: 1,
	initial: () => ({ phase: "finish" }),
	phases: {
		finish: (record, api, ctx) =>
			api.commit(() => ({ status: "terminal", outcome: { status: "completed", result: record.input.value } }), ctx),
	},
	abort: (_record, api, ctx) => api.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});

test.each(["", "has/slash", "__proto__", "1", "123"])("a tool rejects the invalid child task key %j", async (key) => {
	let error: unknown;
	const parent = defineTool({
		name: "parent",
		description: "Check a task key",
		parameters: Type.Object({}),
		async execute(_args, api, ctx) {
			try {
				await api.createTask(worker, { value: 1 }, { key, ownership: { kind: "task", taskId: api.taskId } }, ctx);
			} catch (cause) {
				error = cause;
			}
			return { output: [] };
		},
	});
	await using app = await open([parent], [worker]);
	await app.run();
	expect(error).toBeInstanceOf(Error);
	expect(String(error)).toContain("must be non-empty");
});

test("keyed child tasks reuse their result and reject changed input or a nested-tool collision", async () => {
	const ids: number[] = [],
		errors: unknown[] = [],
		results: unknown[] = [];
	const parent = defineTool({
		name: "parent",
		description: "Create keyed children",
		parameters: Type.Object({}),
		replay: "safe",
		async execute(_args, api, ctx) {
			for (let attempt = 0; attempt < 2; attempt++) {
				const id = await api.createTask(
					worker,
					{ value: 23 },
					{ key: "same", ownership: { kind: "task", taskId: api.taskId } },
					ctx,
				);
				ids.push(id);
				results.push((await api.waitForTask(id, ctx)).state.outcome);
			}
			try {
				await api.createTask(
					worker,
					{ value: 24 },
					{ key: "same", ownership: { kind: "task", taskId: api.taskId } },
					ctx,
				);
			} catch (cause) {
				errors.push(cause);
			}
			try {
				await api.executeTool("parent", {}, ctx, { key: "same" });
			} catch (cause) {
				errors.push(cause);
			}
			return { output: [] };
		},
	});
	await using app = await open([parent], [worker]);
	await app.run();
	expect(ids).toHaveLength(2);
	expect(ids[0]).toBe(ids[1]);
	expect(results).toEqual([
		{ status: "completed", result: 23 },
		{ status: "completed", result: 23 },
	]);
	expect(errors.map(String)).toEqual([
		expect.stringContaining("already used for another call or task"),
		expect.stringContaining("already made with another tool or other arguments"),
	]);
});

test("a woken tool requires explicit keys for new tasks and nested calls", async () => {
	const errors: unknown[] = [];
	let attempts = 0;
	const parent = defineTool({
		name: "parent",
		description: "Wake and create work",
		parameters: Type.Object({}),
		async execute(_args, api, ctx) {
			attempts++;
			if (!api.wake) {
				const id = await api.createTask(
					worker,
					{ value: 1 },
					{ key: "wake", ownership: { kind: "task", taskId: api.taskId } },
					ctx,
				);
				return { wait: { on: [id], policy: "allSettled" } };
			}
			try {
				await api.createTask(worker, { value: 2 }, { ownership: { kind: "task", taskId: api.taskId } }, ctx);
			} catch (cause) {
				errors.push(cause);
			}
			try {
				await api.executeTool("parent", {}, ctx);
			} catch (cause) {
				errors.push(cause);
			}
			return { output: [] };
		},
	});
	await using app = await open([parent], [worker]);
	await app.run();
	expect(attempts).toBe(2);
	expect(errors.map(String)).toEqual([
		expect.stringContaining("explicit keys after a wake"),
		expect.stringContaining("explicit keys after a wake"),
	]);
});
