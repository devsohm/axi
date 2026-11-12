import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@axi/ai";
import { BACKGROUND_CONTEXT as context } from "@axi/objects/context";
import { expect, test } from "vitest";
import {
	createRegistry,
	defineTool,
	Harness,
	LiveDoc,
	MemoryStorage,
	ToolResultEntry,
	ToolTask,
	type JsonObject,
} from "../src/index.ts";

test("a non-JSON tool result clears live progress, faults once and lets the conversation continue", async () => {
	const models = createModels(),
		provider = fauxProvider(),
		registry = createRegistry();
	models.setProvider(provider.provider);
	let executions = 0;
	registry.install({
		name: "broken-output",
		tools: [
			defineTool({
				name: "broken",
				description: "Return invalid numeric details",
				parameters: Type.Object({}),
				async execute(_args, api, ctx) {
					executions++;
					api.output("In progress");
					await api.details({ step: 1 }, ctx);
					api.diagnostic({ severity: "info", message: "Started" });
					return { details: { elapsed: Number.NaN }, output: [] };
				},
			}),
		],
	});
	provider.setResponses([
		fauxAssistantMessage([fauxToolCall("broken", {}, { id: "broken-call" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("The failed tool did not prevent an answer"),
	]);
	const harness = await Harness.open(
		new MemoryStorage(),
		{ models, registry, settings: { compaction: { enabled: false } } },
		context,
	);
	try {
		const conversation = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		const finished: JsonObject[] = [];
		harness.observeCommits({
			advance(publication) {
				for (const change of publication.changes) {
					if (change.type !== "document" || change.kind !== "change" || change.record.kind !== LiveDoc.definition.kind)
						continue;
					if (!Array.isArray(change.value.tools)) continue;
					for (const slot of change.value.tools)
						if (
							slot !== null &&
							typeof slot === "object" &&
							!Array.isArray(slot) &&
							slot.callId === "broken-call" &&
							slot.status === "done"
						)
							finished.push(slot);
				}
			},
			end() {},
		});
		expect(
			await (await conversation.submit({ type: "input", content: "Run the tool" }, context)).wait(context),
		).toMatchObject({ status: "done" });
		await conversation.waitForIdle(context);
		const tasks = await harness.commit(
			(tx) => tx.scanTasks({ conversationId: conversation.id, kind: ToolTask.definition.name }, 10),
			context,
		);
		expect(tasks.items).toHaveLength(1);
		expect(tasks.items[0]?.state).toMatchObject({ status: "terminal", outcome: { status: "faulted" } });
		expect(executions).toBe(1);
		expect(provider.state.callCount).toBe(2);
		expect(finished.length).toBeGreaterThan(0);
		for (const slot of finished) {
			expect(slot).not.toHaveProperty("output");
			expect(slot).not.toHaveProperty("details");
			expect(slot).not.toHaveProperty("diagnostics");
			expect(slot).not.toHaveProperty("entry");
		}
		expect((await conversation.entries({}, 20, undefined, context)).items.filter(ToolResultEntry.is)).toEqual([]);
		expect(await harness.snapshot(LiveDoc, conversation.id, context)).toEqual({});
	} finally {
		await harness.close(context);
	}
});
