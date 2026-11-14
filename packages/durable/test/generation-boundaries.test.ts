import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@axi/ai";
import { BACKGROUND_CONTEXT as context, awaitWithContext } from "@axi/objects/context";
import { expect, test } from "vitest";
import {
	createRegistry,
	defineTool,
	Harness,
	LiveDoc,
	MemoryStorage,
	ToolResultEntry,
	ToolTask,
	type HarnessSettings,
	type Report,
} from "../src/index.ts";

async function fixture(settings: HarnessSettings = {}) {
	const models = createModels(),
		provider = fauxProvider(),
		registry = createRegistry(),
		reports: Report[] = [];
	models.setProvider(provider.provider);
	const harness = await Harness.open(
		new MemoryStorage(),
		{
			models,
			registry,
			settings: { compaction: { enabled: false }, ...settings },
			onReport: (report) => reports.push(report),
		},
		context,
	);
	const conversation = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	return { harness, conversation, provider, registry, reports };
}

test("continue without unanswered input settles without sending another model request", async () => {
	const f = await fixture();
	try {
		const empty = await f.conversation.submit({ type: "continue", requestId: "empty" }, context);
		expect(await empty.wait(context)).toMatchObject({
			type: "continue",
			status: "unanswered",
			reason: "nothing_to_answer",
		});
		expect(f.provider.state.callCount).toBe(0);
		f.provider.setResponses([fauxAssistantMessage("Completed answer")]);
		expect(
			await (await f.conversation.submit({ type: "input", content: "Answer this" }, context)).wait(context),
		).toMatchObject({ status: "done" });
		const answered = await f.conversation.submit({ type: "continue", requestId: "answered" }, context);
		expect(await answered.wait(context)).toMatchObject({ status: "unanswered", reason: "nothing_to_answer" });
		expect((await f.conversation.submit({ type: "continue", requestId: "answered" }, context)).id).toBe(answered.id);
		expect(f.provider.state.callCount).toBe(1);
		expect((await f.harness.snapshot(LiveDoc, f.conversation.id, context))?.runFailure?.reason).toBe(
			"nothing_to_answer",
		);
	} finally {
		await f.harness.close(context);
	}
});

test("aborting a sequential round records the running and unstarted calls in model order", async () => {
	const f = await fixture({ toolExecution: "sequential" }),
		started = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	const invoked: number[] = [];
	f.registry.install({
		name: "work",
		tools: [
			defineTool({
				name: "work",
				description: "Complete an item",
				parameters: Type.Object({ item: Type.Integer() }),
				async execute({ item }, _api, ctx) {
					invoked.push(item);
					started.resolve();
					await awaitWithContext(release.promise, ctx);
					return { output: [] };
				},
			}),
		],
	});
	f.provider.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall("work", { item: 0 }, { id: "first" }),
				fauxToolCall("absent", {}, { id: "unavailable" }),
				fauxToolCall("work", { item: 1 }, { id: "last" }),
			],
			{ stopReason: "toolUse" },
		),
	]);
	try {
		const submission = await f.conversation.submit({ type: "input", content: "Complete these items" }, context);
		await started.promise;
		const live = await f.harness.snapshot(LiveDoc, f.conversation.id, context);
		if (!live?.run) throw new Error("The generation was not running");
		expect(live.tools?.map((slot) => slot.taskId !== undefined)).toEqual([true, false, false]);
		await f.harness.abortTask(live.run.taskId, context);
		expect(await submission.wait(context)).toMatchObject({ status: "unanswered", reason: "aborted" });
		await f.harness.waitForIdle(context);
		const results = (await f.conversation.entries({ order: "ascending" }, 100, undefined, context)).items.filter(
			ToolResultEntry.is,
		);
		expect(results.flatMap((entry) => entry.model ?? [])).toMatchObject([
			{ role: "toolResult", toolCallId: "first", isError: true },
			{ role: "toolResult", toolCallId: "unavailable", isError: true },
			{ role: "toolResult", toolCallId: "last", isError: true },
		]);
		expect(results.map((entry) => entry.data?.diagnostics.map((item) => item.code))).toEqual([
			["aborted"],
			["tool_unavailable"],
			["aborted"],
		]);
		expect(invoked).toEqual([0]);
		expect(
			(
				await f.harness.commit(
					(tx) => tx.scanTasks({ conversationId: f.conversation.id, kind: ToolTask.definition.name }, 20),
					context,
				)
			).items,
		).toHaveLength(1);
		expect(f.provider.state.callCount).toBe(1);
	} finally {
		release.resolve();
		await f.harness.close(context);
	}
});

test("a failed prompt section retains its committed text and reports its owning extension", async () => {
	const f = await fixture(),
		failure = new Error("Instruction source unavailable");
	let fail = false;
	f.registry.install({
		name: "instructions",
		sections: [
			{
				key: "policy",
				render() {
					if (fail) throw failure;
					return "Keep changes small";
				},
			},
		],
	});
	f.provider.setResponses([
		fauxAssistantMessage("First answer"),
		(request) => {
			expect(
				request.messages.filter((message) => message.role === "system").map((message) => message.sections?.policy),
			).toContain("<policy>\nKeep changes small\n</policy>");
			return fauxAssistantMessage("Second answer");
		},
	]);
	try {
		expect(
			await (await f.conversation.submit({ type: "input", content: "First" }, context)).wait(context),
		).toMatchObject({ status: "done" });
		fail = true;
		expect(
			await (await f.conversation.submit({ type: "input", content: "Second" }, context)).wait(context),
		).toMatchObject({ status: "done" });
		expect(f.reports).toMatchObject([{ error: failure, kind: "extension_error", extension: "instructions" }]);
		expect(f.provider.state.callCount).toBe(2);
	} finally {
		await f.harness.close(context);
	}
});
