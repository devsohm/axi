import { createModels, fauxAssistantMessage, fauxProvider } from "@axi/ai";
import { BACKGROUND_CONTEXT as context } from "@axi/objects/context";
import { expect, test } from "vitest";
import { createRegistry, defineExtension, defineTask, GenerationTask, Harness, hook, MemoryStorage, UserEntry } from "../src/index.ts";

test("hooks and tasks page committed history within their conversation", async () => {
	const provider = fauxProvider(), models = createModels(), registry = createRegistry();
	models.setProvider(provider.provider);
	const observed: string[] = [];
	registry.install(defineExtension({ name: "reader", hooks: [hook(GenerationTask, {
		onYield: async (_answer, api, ctx) => {
			const page = await api.entries({ order: "ascending" }, 1, undefined, ctx);
			const entry = await api.entry(UserEntry, page.items[0]!.id, ctx);
			observed.push(entry!.kind);
		},
	})] }));
	const Reader = defineTask<null, { phase: "run" }, null>({
		name: "reader.task", version: 1, initial: () => ({ phase: "run" }),
		phases: { run: async (_task, runtime, ctx) => {
			const page = await runtime.entries({ order: "descending" }, 1, undefined, ctx);
			const id = page.items[0]!.id;
			const bounded = await runtime.entries({ minEntryId: id, maxEntryId: id }, 10, undefined, ctx);
			expect(bounded.items.map(row => row.id)).toEqual([id]);
			observed.push(page.items[0]!.kind);
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx);
		} }, abort: async () => {},
	});
	registry.install(defineExtension({ name: "task", tasks: [Reader] }));
	provider.setResponses([fauxAssistantMessage("complete")]);
	const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
	try {
		const conversation = await harness.root(context, { agent: { model: { provider: provider.provider.id, modelId: provider.getModel().id } } });
		await (await conversation.submit({ type: "input", content: "request" }, context)).wait(context);
		const task = await conversation.commit(tx => tx.createTask(Reader, null, { ownership: { kind: "conversation" } }), context);
		await harness.waitForTask(task, context);
		expect(observed).toEqual(["axi.user", "axi.assistant"]);
	} finally { await harness.close(context); }
});
