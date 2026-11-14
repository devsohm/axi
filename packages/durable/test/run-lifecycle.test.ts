import { createModels, fauxAssistantMessage, fauxProvider } from "@axi/ai";
import { BACKGROUND_CONTEXT as context } from "@axi/objects/context";
import { expect, test } from "vitest";
import {
	createRegistry,
	defineExtension,
	defineTask,
	GenerationTask,
	Harness,
	hook,
	LiveDoc,
	MemoryStorage,
	hookTask,
	type RunSummary,
} from "../src/index.ts";

test("closing a session drains the current context page and refuses a later page", async () => {
	const entered = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	const calls: string[] = [];
	let armed = false;
	class Storage extends MemoryStorage {
		override async scanEntries(...args: Parameters<MemoryStorage["scanEntries"]>) {
			if (armed && args[1] > 1) {
				calls.push(args[2] === undefined ? "first" : "next");
				if (args[2] === undefined) {
					entered.resolve();
					await release.promise;
				}
			}
			return super.scanEntries(...args);
		}
		override async close(ctx: Parameters<MemoryStorage["close"]>[0]) {
			calls.push("close");
			await super.close(ctx);
		}
	}
	const harness = await Harness.open(new Storage(), { models: createModels(), registry: createRegistry() }, context);
	try {
		const conversation = await harness.root(context);
		await conversation.commit(async (tx) => {
			for (let index = 0; index < 333; index++) await tx.appendEntry(conversation.id, { kind: "entry", data: index });
		}, context);
		armed = true;
		const reading = conversation.context(context);
		const rejected = expect(reading).rejects.toThrow("Session is closed");
		await entered.promise;
		const closing = harness.close(context);
		release.resolve();
		await rejected;
		await closing;
		expect(calls).toEqual(["first", "close"]);
		expect(await harness.closed).toEqual({ kind: "closed" });
	} finally {
		release.resolve();
		await harness.close(context);
	}
});

test("continues a failed run and settles its answer before draining after-run work", async () => {
	const models = createModels(),
		provider = fauxProvider(),
		registry = createRegistry();
	models.setProvider(provider.provider);
	const started = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	const runs: string[] = [],
		summaries: RunSummary[] = [];
	const Check = defineTask<string, { phase: "check" }, null>({
		name: "checks",
		version: 1,
		initial: () => ({ phase: "check" }),
		phases: {
			check: async (task, runtime, ctx) => {
				runs.push(task.input);
				started.resolve();
				await release.promise;
				await runtime.commit(async (tx) => {
					await tx.appendEntry(runtime.conversationId, { kind: "checks.done" });
					return { status: "terminal", outcome: { status: "completed", result: null } };
				}, ctx);
			},
		},
		abort: async (_task, runtime, ctx) => {
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
		},
	});
	registry.install(
		defineExtension({
			name: "checks",
			tasks: [Check],
			hooks: [
				hook(GenerationTask, {
					afterRun: (run) => {
						summaries.push(run);
						return { tasks: [hookTask(Check, "check")] };
					},
				}),
			],
		}),
	);
	provider.setResponses([
		fauxAssistantMessage([], { stopReason: "error", errorMessage: "Invalid request" }),
		fauxAssistantMessage("recovered"),
		fauxAssistantMessage("next"),
	]);
	const harness = await Harness.open(
		new MemoryStorage(),
		{ models, registry, settings: { retry: { enabled: false }, compaction: { enabled: false } } },
		context,
	);
	try {
		const conversation = await harness.root(context, {
			agent: { model: { provider: provider.provider.id, modelId: provider.getModel().id } },
		});
		const original = await (await conversation.submit({ type: "input", content: "request" }, context)).wait(context);
		expect(original).toMatchObject({ status: "unanswered", reason: "model_error" });
		const continuing = await conversation.submit({ type: "continue", requestId: "retry" }, context);
		await started.promise;
		expect(await continuing.status(context)).toMatchObject({ type: "continue", status: "done" });
		expect((await conversation.submit({ type: "continue", requestId: "retry" }, context)).id).toBe(continuing.id);
		expect((await harness.snapshot(LiveDoc, conversation.id, context))?.run?.afterRun?.tasks).toHaveLength(1);
		const next = await conversation.submit({ type: "input", content: "next" }, context);
		expect(await next.status(context)).toMatchObject({ status: "queued" });
		release.resolve();
		await next.wait(context);
		await conversation.waitForIdle(context);
		expect(summaries).toHaveLength(2);
		expect(summaries[0]?.first).toBe(original.entry);
		expect(runs).toEqual(["check", "check"]);
		expect(
			(await conversation.entries({ order: "ascending" }, 20, undefined, context)).items.map((entry) => entry.kind),
		).toEqual([
			"axi.user",
			"axi.assistant",
			"axi.assistant",
			"checks.done",
			"axi.user",
			"axi.assistant",
			"checks.done",
		]);
	} finally {
		release.resolve();
		await harness.close(context);
	}
});
