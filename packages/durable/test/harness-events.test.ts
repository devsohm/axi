import { expect, test, vi } from "vitest";
import { createModels, fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall, Type } from "@axi/ai";
import { BACKGROUND_CONTEXT as context } from "@axi/chord/context";
import { Harness, MemoryStorage, createRegistry, defineTool, watchEvents, type AgentEvent } from "../src/index.ts";

test("the public event stream carries a complete model/tool run and resumes with committed history", async () => {
	const models = createModels(),
		provider = fauxProvider(),
		registry = createRegistry();
	models.setProvider(provider.provider);
	registry.install({
		name: "echo-tools",
		tools: [
			defineTool({
				name: "echo",
				description: "Echo input",
				parameters: Type.Object({ text: Type.String() }),
				async execute(args, api) {
					api.output("working");
					return { output: [{ type: "text", text: "echoed:" + args.text }] };
				},
			}),
		],
	});
	const harness = await Harness.open(
		new MemoryStorage(),
		{ models, registry, settings: { progress: { partialIntervalMs: 0, outputIntervalMs: 0 } } },
		context,
	);
	try {
		const conversation = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		const stream = await watchEvents(harness, conversation.id, context),
			events: AgentEvent[] = [];
		stream.start(async (batch) => {
			events.push(...batch);
		});
		try {
			provider.setResponses([
				fauxAssistantMessage([fauxToolCall("echo", { text: "hello" }, { id: "echo-call" })], { stopReason: "toolUse" }),
				fauxAssistantMessage([fauxText("finished")]),
			]);
			expect(
				(await (await conversation.submit({ type: "input", content: "start" }, context)).wait(context)).status,
			).toBe("done");
			await vi.waitFor(() => expect(events.some((event) => event.type === "run_end")).toBe(true));
			expect(
				events
					.filter((event) => event.type === "tool_execution_start")
					.map((event) => ({ name: event.toolName, args: event.args, call: event.toolCallId })),
			).toEqual([{ name: "echo", args: { text: "hello" }, call: "echo-call" }]);
			expect(
				events.filter((event) => event.type === "tool_execution_end").map((event) => event.entry?.model?.[0]?.content),
			).toEqual([[{ type: "text", text: "echoed:hello" }]]);
			const order = events.map((event) => event.type);
			expect(order.indexOf("run_start")).toBeLessThan(order.indexOf("tool_execution_start"));
			expect(order.indexOf("tool_execution_start")).toBeLessThan(order.indexOf("tool_execution_end"));
			expect(order.indexOf("tool_execution_end")).toBeLessThan(order.indexOf("run_end"));
		} finally {
			await stream.stop();
		}
		const resumed = await watchEvents(harness, conversation.id, context);
		try {
			expect(resumed.snapshot.entries.flatMap((entry) => entry.model?.map((message) => message.role) ?? [])).toEqual([
				"user",
				"system",
				"assistant",
				"toolResult",
				"assistant",
			]);
		} finally {
			await resumed.stop();
		}
	} finally {
		await harness.close(context);
	}
});
