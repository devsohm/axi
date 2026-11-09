import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@axi/ai";
import { BACKGROUND_CONTEXT as context } from "@axi/objects/context";
import { expect, test } from "vitest";
import { createRegistry, defineExtension, defineTool, Harness, MemoryStorage } from "../src/index.ts";
import { createToolSearchExtension } from "../src/tool-search/index.ts";

test.each([
	["zebrakey", true],
	["unusedsecret", false],
] as const)("deferred search follows reachable recursive definitions for %s", async (query, found) => {
	const models = createModels(),
		provider = fauxProvider(),
		registry = createRegistry();
	models.setProvider(provider.provider);
	registry.install(createToolSearchExtension());
	registry.install(
		defineExtension({
			name: "records",
			tools: [
				defineTool({
					name: "lookup",
					description: "Find a record",
					deferred: true,
					parameters: Type.Object(
						{ input: Type.Ref("#/$defs/Node") },
						{
							$defs: {
								Node: { type: "object", properties: { zebrakey: { type: "string" }, next: { $ref: "#/$defs/Node" } } },
								Unused: { type: "object", properties: { unusedsecret: { type: "string" } } },
							},
						},
					),
					async execute() {
						return { output: [] };
					},
				}),
			],
		}),
	);
	provider.setResponses([
		fauxAssistantMessage([fauxToolCall("tool_search", { query }, { id: "discover" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
	try {
		const conversation = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		expect(
			(await (await conversation.submit({ type: "input", content: "Find the matching tool" }, context)).wait(context))
				.status,
		).toBe("done");
		expect((await conversation.agent(context)).tools.some((tool) => tool.name === "lookup")).toBe(found);
	} finally {
		await harness.close(context);
	}
});
