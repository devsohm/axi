import { createModels, fauxAssistantMessage, fauxProvider } from "@axi/ai";
import { BACKGROUND_CONTEXT as context } from "@axi/objects/context";
import { expect, test } from "vitest";
import {
	CompactionEntry,
	CompactionTask,
	createRegistry,
	defineExtension,
	Harness,
	hook,
	LiveDoc,
	MemoryStorage,
} from "../src/index.ts";

test.each(["blocking", "background"] as const)(
	"%s threshold compaction preserves raw history and settles the admitted input",
	async (mode) => {
		const models = createModels(),
			provider = fauxProvider({ models: [{ id: "small", contextWindow: 2000, maxTokens: 500 }] }),
			registry = createRegistry();
		models.setProvider(provider.provider);
		const reasons: string[] = [];
		registry.install(
			defineExtension({
				name: "summarizer",
				hooks: [
					hook(CompactionTask, {
						beforeCompact(input) {
							reasons.push(input.reason);
							return { summary: "Earlier decisions retained." };
						},
					}),
				],
			}),
		);
		provider.setResponses([fauxAssistantMessage("old ".repeat(600)), fauxAssistantMessage("final answer")]);
		const harness = await Harness.open(
			new MemoryStorage(),
			{
				models,
				registry,
				settings: {
					retry: { enabled: false },
					compaction: {
						enabled: true,
						reserveTokens: 500,
						keepRecentTokens: 200,
						backgroundTokens: mode === "blocking" ? 0 : 600,
					},
				},
			},
			context,
		);
		try {
			const conversation = await harness.root(context, { agent: { model: { provider: "faux", modelId: "small" } } });
			await (await conversation.submit({ type: "input", content: "old ".repeat(600) }, context)).wait(context);
			const before = (await conversation.entries({ order: "ascending" }, 100, undefined, context)).items;
			const receipt = await conversation.submit(
				{ type: "input", content: "new ".repeat(mode === "blocking" ? 400 : 50), requestId: "after-compaction" },
				context,
			);
			expect(await receipt.wait(context)).toMatchObject({ status: "done" });
			await harness.waitForIdle(context);
			const after = (await conversation.entries({ order: "ascending" }, 100, undefined, context)).items;
			expect(after.slice(0, before.length)).toEqual(before);
			expect(reasons).toEqual(["threshold"]);
			expect(after.filter(CompactionEntry.is).map((entry) => entry.data.reason)).toEqual(["threshold"]);
			expect(JSON.stringify((await conversation.context(context)).messages)).toContain("Earlier decisions retained.");
			expect(
				(await conversation.submit({ type: "input", content: "duplicate", requestId: "after-compaction" }, context)).id,
			).toBe(receipt.id);
			expect(provider.state.callCount).toBe(2);
			expect(await harness.snapshot(LiveDoc, conversation.id, context)).toEqual({});
		} finally {
			await harness.close(context);
		}
	},
);

test.each([false, true])("overflow compaction %s decline cannot create an endless retry", async (decline) => {
	const models = createModels(),
		provider = fauxProvider(),
		registry = createRegistry();
	models.setProvider(provider.provider);
	const reasons: string[] = [];
	registry.install(
		defineExtension({
			name: "summarizer",
			hooks: [
				hook(CompactionTask, {
					beforeCompact(input) {
						reasons.push(input.reason);
						return decline ? { decline: true } : { summary: "Earlier context summarized." };
					},
				}),
			],
		}),
	);
	provider.setResponses([
		fauxAssistantMessage("old ".repeat(300)),
		fauxAssistantMessage([], { stopReason: "error", errorMessage: "maximum context length is 1000 tokens" }),
		fauxAssistantMessage("recovered answer"),
	]);
	const harness = await Harness.open(
		new MemoryStorage(),
		{
			models,
			registry,
			settings: {
				retry: { enabled: false },
				compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 100, backgroundTokens: 0 },
			},
		},
		context,
	);
	try {
		const conversation = await harness.root(context, {
			agent: { model: { provider: "faux", modelId: provider.getModel().id } },
		});
		await (await conversation.submit({ type: "input", content: "old ".repeat(300) }, context)).wait(context);
		const receipt = await (await conversation.submit({ type: "input", content: "continue" }, context)).wait(context);
		expect(receipt).toMatchObject(
			decline
				? { status: "unanswered", reason: "model_error", detail: "maximum context length is 1000 tokens" }
				: { status: "done" },
		);
		await harness.waitForIdle(context);
		expect(reasons).toEqual(["overflow"]);
		expect(provider.state.callCount).toBe(decline ? 2 : 3);
		const entries = (await conversation.entries({}, 100, undefined, context)).items;
		expect(entries.filter(CompactionEntry.is)).toHaveLength(decline ? 0 : 1);
	} finally {
		await harness.close(context);
	}
});

test("failed threshold compaction settles generation without sending the oversized follow-up", async () => {
	const models = createModels(),
		provider = fauxProvider({ models: [{ id: "small", contextWindow: 2000 }] });
	models.setProvider(provider.provider);
	provider.setResponses([
		fauxAssistantMessage("old ".repeat(600)),
		fauxAssistantMessage([], { stopReason: "error", errorMessage: "summary rejected" }),
		fauxAssistantMessage("must remain unused"),
	]);
	const harness = await Harness.open(
		new MemoryStorage(),
		{
			models,
			registry: createRegistry(),
			settings: {
				retry: { enabled: false },
				compaction: { enabled: true, reserveTokens: 500, keepRecentTokens: 200, backgroundTokens: 0 },
			},
		},
		context,
	);
	try {
		const conversation = await harness.root(context, { agent: { model: { provider: "faux", modelId: "small" } } });
		await (await conversation.submit({ type: "input", content: "old ".repeat(600) }, context)).wait(context);
		const receipt = await (await conversation.submit({ type: "input", content: "new ".repeat(400) }, context)).wait(
			context,
		);
		expect(receipt).toMatchObject({
			status: "unanswered",
			reason: "model_error",
			detail: expect.stringContaining("summary rejected"),
		});
		await harness.waitForIdle(context);
		expect(provider.state.callCount).toBe(2);
		expect(provider.getPendingResponseCount()).toBe(1);
	} finally {
		await harness.close(context);
	}
});
