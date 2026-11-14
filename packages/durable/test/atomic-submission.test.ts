import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@axi/ai";
import { BACKGROUND_CONTEXT as context } from "@axi/objects/context";
import { expect, test, vi } from "vitest";
import {
	type ConversationHandle,
	ConversationIdle,
	createRegistry,
	defineExtension,
	defineTool,
	Harness,
	MemoryStorage,
	ReadAfterWrite,
} from "../src/index.ts";

test("submission admission shares rollback and table-write ordering with its caller", async () => {
	const options = { models: createModels(), registry: createRegistry() };
	const harness = await Harness.open(new MemoryStorage(), options, context);
	const other = await Harness.open(new MemoryStorage(), options, context);
	try {
		const conversation = await harness.root(context);
		await other.root(context);
		await expect(
			conversation.commit(async (tx) => {
				await conversation.submit(tx, { type: "write", entry: { kind: "discarded" } });
				throw new Error("rollback");
			}, context),
		).rejects.toThrow("rollback");
		expect((await conversation.entries({}, 10, undefined, context)).items).toEqual([]);
		await expect(
			other.commit((tx) => conversation.submit(tx, { type: "write", entry: { kind: "foreign" } }), context),
		).rejects.toThrow("another Session");
		await expect(
			conversation.commit(async (tx) => {
				await tx.appendEntry(conversation.id, { kind: "first" });
				return conversation.submit(tx, { type: "write", entry: { kind: "late" } });
			}, context),
		).rejects.toBeInstanceOf(ReadAfterWrite);
		await expect(
			conversation.submit({ type: "input", content: "steer", whenIdle: "reject" }, context),
		).rejects.toBeInstanceOf(ConversationIdle);
		const id = await conversation.commit(
			(tx) => conversation.submit(tx, { type: "write", entry: { kind: "kept" } }),
			context,
		);
		expect(await (await harness.submission(id, context))!.status(context)).toMatchObject({
			type: "write",
			status: "done",
		});
		expect((await conversation.entries({}, 10, undefined, context)).items.map((row) => row.kind)).toEqual(["kept"]);
	} finally {
		await harness.close(context);
		await other.close(context);
	}
});

test("an aborted invocation rejects later submissions as an expired handle", async () => {
	const models = createModels(),
		provider = fauxProvider(),
		registry = createRegistry();
	models.setProvider(provider.provider);
	const entered = Promise.withResolvers<{ handle: ConversationHandle; signal: AbortSignal }>();
	const release = Promise.withResolvers<void>();
	registry.install(
		defineExtension({
			name: "held-conversation",
			tools: [
				defineTool({
					name: "hold",
					description: "Wait for release",
					parameters: Type.Object({}),
					execute: async (_args, api, ctx) => {
						const handle = await api.conversation(api.conversationId, ctx);
						if (!handle || !ctx.abortSignal) throw new Error("Invocation context is missing");
						entered.resolve({ handle, signal: ctx.abortSignal });
						await release.promise;
						return { output: [] };
					},
				}),
			],
		}),
	);
	provider.setResponses([fauxAssistantMessage([fauxToolCall("hold", {})], { stopReason: "toolUse" })]);
	const harness = await Harness.open(
		new MemoryStorage(),
		{ models, registry, settings: { compaction: { enabled: false } } },
		context,
	);
	try {
		const conversation = await harness.root(context, {
			agent: { model: { provider: provider.provider.id, modelId: provider.getModel().id } },
		});
		await conversation.submit({ type: "input", content: "Wait" }, context);
		const { handle, signal } = await entered.promise;
		const abort = conversation.abort(context);
		await vi.waitFor(() => expect(signal.aborted).toBe(true));
		release.resolve();
		await abort;
		await expect(handle.submit({ type: "continue" }, context)).rejects.toMatchObject({
			name: "Error",
			message: expect.stringContaining("invocation has ended"),
		});
	} finally {
		release.resolve();
		await harness.close(context);
	}
});
