import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@axi/ai";
import { BACKGROUND_CONTEXT as context } from "@axi/objects/context";
import { expect, test, vi } from "vitest";
import {
	createRegistry,
	defineExtension,
	defineTool,
	Harness,
	hook,
	LiveDoc,
	MemoryStorage,
	ToolResultEntry,
	ToolTask,
	type JsonObject,
	type ToolHooks,
	type ToolRegistration,
} from "../src/index.ts";

const definition = { name: "check", description: "Check text", parameters: Type.Object({ text: Type.String() }) };
async function fixture(tool: ToolRegistration, handlers: readonly Partial<ToolHooks>[]) {
	const models = createModels(),
		provider = fauxProvider(),
		registry = createRegistry();
	models.setProvider(provider.provider);
	registry.install(defineExtension({ name: "tools", tools: [tool] }));
	for (const [index, handler] of handlers.entries())
		registry.install(
			defineExtension({
				name: `hook${index}`,
				hooks: [hook(ToolTask, handler)],
			}),
		);
	const harness = await Harness.open(
		new MemoryStorage(),
		{
			models,
			registry,
			settings: { compaction: { enabled: false } },
		},
		context,
	);
	const conversation = await harness.root(context, {
		agent: { model: { provider: "faux", modelId: provider.getModel().id } },
	});
	return {
		harness,
		conversation,
		async run(arguments_: JsonObject = { text: "requested" }) {
			provider.setResponses([
				fauxAssistantMessage([fauxToolCall(tool.name, arguments_, { id: "call" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("finished"),
			]);
			const receipt = await conversation.submit({ type: "input", content: "Run the check" }, context);
			expect(await receipt.wait(context)).toMatchObject({ status: "done" });
			await harness.waitForIdle(context);
			const results = (await conversation.entries({ order: "ascending" }, 100, undefined, context)).items.filter(
				ToolResultEntry.is,
			);
			expect(results).toHaveLength(1);
			const entry = results[0];
			if (!entry) throw new Error("The tool result is missing");
			expect(await harness.snapshot(LiveDoc, conversation.id, context)).toEqual({});
			return entry;
		},
		async [Symbol.asyncDispose]() {
			await harness.close(context);
		},
	};
}

test.each(["block", "throw-error", "throw-string"] as const)(
	"a %s before-hook stops later admission hooks and never executes the tool",
	async (mode) => {
		const execute = vi.fn(async () => ({ output: [] }));
		const later = vi.fn(),
			resultCodes: (string | undefined)[][] = [];
		await using app = await fixture(defineTool({ ...definition, execute }), [
			{
				beforeTool() {
					if (mode === "throw-error") throw new Error("policy refused");
					if (mode === "throw-string") throw "policy refused";
					return { block: "policy refused" };
				},
			},
			{
				beforeTool: later,
				afterTool(_call, result) {
					resultCodes.push((result.diagnostics ?? []).map((item) => item.code));
				},
			},
		]);
		const entry = await app.run();
		expect(entry.model?.[0]).toMatchObject({ role: "toolResult", isError: true });
		expect(entry.data?.diagnostics.map((item) => item.code)).toEqual(["blocked"]);
		expect(resultCodes).toEqual([["blocked"]]);
		expect(later).not.toHaveBeenCalled();
		expect(execute).not.toHaveBeenCalled();
	},
);

const invalidArguments: JsonObject[] = [{}, { text: { nested: true } }];
test.each(invalidArguments)(
	"a before-hook argument rewrite %j is validated again before execution",
	async (arguments_) => {
		const execute = vi.fn(async () => ({ output: [] }));
		await using app = await fixture(defineTool({ ...definition, execute }), [
			{ beforeTool: () => ({ arguments: arguments_ }) },
		]);
		const entry = await app.run();
		expect(entry.model?.[0]).toMatchObject({ role: "toolResult", isError: true });
		expect(entry.data?.diagnostics.map((item) => item.code)).toEqual(["invalid_arguments"]);
		expect(execute).not.toHaveBeenCalled();
	},
);

test("a scalar argument rewrite is converted to the tool schema before execution", async () => {
	const received: unknown[] = [];
	await using app = await fixture(
		defineTool({
			...definition,
			async execute(args) {
				received.push(args);
				return { output: [{ type: "text", text: args.text }] };
			},
		}),
		[{ beforeTool: () => ({ arguments: { text: 42 } }) }],
	);
	const entry = await app.run();
	expect(received).toEqual([{ text: "42" }]);
	expect(entry.model?.[0]).toMatchObject({
		role: "toolResult",
		isError: false,
		content: [{ type: "text", text: "42" }],
	});
});

test.each([new Error("argument preparation failed"), "argument preparation failed"])(
	"argument preparation failure %j is committed as an invalid-argument result",
	async (failure) => {
		const execute = vi.fn(async () => ({ output: [] }));
		await using app = await fixture(
			defineTool({
				...definition,
				execute,
				prepareArguments() {
					throw failure;
				},
			}),
			[],
		);
		const entry = await app.run();
		expect(entry.model?.[0]).toMatchObject({ role: "toolResult", isError: true });
		expect(entry.data?.diagnostics).toEqual([
			expect.objectContaining({ code: "invalid_arguments", message: "argument preparation failed" }),
		]);
		expect(execute).not.toHaveBeenCalled();
	},
);

test.each(["head", "tail"] as const)(
	"a result hook's replacement output still obeys its %s retention limit",
	async (retain) => {
		const execute = vi.fn(async () => ({ output: [] }));
		await using app = await fixture(defineTool({ ...definition, execute, outputLimits: { maxBytes: 4, retain } }), [
			{
				beforeTool: () => ({ block: "requires confirmation" }),
				afterTool: (_call, result) => ({ ...result, isError: false, output: [{ type: "text", text: "abcdefghijk" }] }),
			},
		]);
		const entry = await app.run();
		expect(entry.model?.[0]).toMatchObject({
			role: "toolResult",
			isError: false,
			content: [{ type: "text", text: retain === "head" ? "abcd" : "hijk" }, expect.anything()],
		});
		expect(entry.data?.diagnostics.map((item) => item.code)).toEqual(["blocked", "truncated"]);
		expect(execute).not.toHaveBeenCalled();
	},
);

test("a nested unavailable tool can be repaired by a result hook and its keyed result is reused", async () => {
	const nested: unknown[] = [],
		parents: unknown[] = [];
	const tool = defineTool({
		...definition,
		async execute(_args, api, call) {
			const first = await api.executeTool("missing", {}, call, { key: "repaired" });
			const second = await api.executeTool("missing", {}, call, { key: "repaired" });
			nested.push(first, second);
			return { output: [{ type: "text", text: String(second.structuredOutput) }] };
		},
	});
	await using app = await fixture(tool, [
		{
			afterTool(call, result) {
				if (!call.parent) return;
				parents.push(call.parent);
				expect(result.diagnostics?.map((item) => item.code)).toEqual(["tool_unavailable"]);
				return { isError: false, output: [{ type: "text", text: "hook repair" }] };
			},
		},
	]);
	const entry = await app.run();
	expect(nested).toMatchObject([
		{ isError: false, structuredOutput: "hook repair" },
		{ isError: false, structuredOutput: "hook repair" },
	]);
	expect(parents).toEqual([expect.objectContaining({ callId: "call" })]);
	expect(entry.model?.[0]).toMatchObject({ role: "toolResult", content: [{ type: "text", text: "hook repair" }] });
});
