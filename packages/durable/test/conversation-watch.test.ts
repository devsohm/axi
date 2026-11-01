import { expect, test, vi } from "vitest";
import { createModels, fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall, Type } from "@axi/ai";
import { BACKGROUND_CONTEXT as context } from "@axi/objects/context";
import { Harness, MemoryStorage, createRegistry, defineTool, LiveDoc } from "../src/index.ts";

test("conversation state exposes a model/tool run and reconnects with committed history", async () => {
	const models = createModels(),
		provider = fauxProvider(),
		registry = createRegistry();
	models.setProvider(provider.provider);
	const called: string[] = [];
	registry.install({
		name: "echo-tools",
		tools: [
			defineTool({
				name: "echo",
				description: "Echo input",
				parameters: Type.Object({ text: Type.String() }),
				async execute(args, api) {
					called.push(args.text);
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
		const stream = await conversation.watch(context);
		let busy = false;
		stream.start(async (call) => {
			if (call.kind === "failed") throw call.error;
			busy ||= call.value.docs[LiveDoc.definition.kind]?.run !== undefined;
		});
		try {
			provider.setResponses([
				fauxAssistantMessage([fauxToolCall("echo", { text: "hello" }, { id: "echo-call" })], { stopReason: "toolUse" }),
				fauxAssistantMessage([fauxText("finished")]),
			]);
			expect(
				(await (await conversation.submit({ type: "input", content: "start" }, context)).wait(context)).status,
			).toBe("done");
			await vi.waitFor(() => expect(stream.value.docs[LiveDoc.definition.kind]?.run).toBeUndefined());
			expect(busy).toBe(true);
			expect(called).toEqual(["hello"]);
			expect(
				stream.value.entries.find((entry) => entry.model?.[0]?.role === "toolResult")?.model?.[0]?.content,
			).toEqual([{ type: "text", text: "echoed:hello" }]);
		} finally {
			await stream.stop();
		}
		const resumed = await conversation.watch(context);
		try {
			expect(resumed.value.entries.flatMap((entry) => entry.model?.map((message) => message.role) ?? [])).toEqual([
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
