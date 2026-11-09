import { createModels, fauxAssistantMessage, fauxProvider } from "@axi/ai";
import { BACKGROUND_CONTEXT as context, awaitWithContext, withAbortSignal } from "@axi/objects/context";
import { expect, test } from "vitest";
import {
	CompactionEntry,
	CompactionTask,
	createRegistry,
	Harness,
	hook,
	LiveDoc,
	MemoryStorage,
} from "../src/index.ts";

async function fixture(retry = { enabled: true, maxRetries: 1, baseDelayMs: 0 }) {
	const models = createModels(),
		provider = fauxProvider(),
		registry = createRegistry();
	models.setProvider(provider.provider);
	const harness = await Harness.open(
		new MemoryStorage(),
		{
			models,
			registry,
			settings: {
				retry,
				compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 200, backgroundTokens: 0 },
			},
		},
		context,
	);
	try {
		const conversation = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		for (const turn of [1, 2]) {
			provider.setResponses([fauxAssistantMessage(`answer ${turn} ` + "details ".repeat(300))]);
			expect(
				await (
					await conversation.submit({ type: "input", content: `question ${turn} ` + "history ".repeat(300) }, context)
				).wait(context),
			).toMatchObject({ status: "done" });
		}
		return {
			harness,
			conversation,
			models,
			provider,
			registry,
			async [Symbol.asyncDispose]() {
				await harness.close(context);
			},
		};
	} catch (error) {
		await harness.close(context);
		throw error;
	}
}

test.each([
	{ enabled: true, maxRetries: 1, expectedCalls: 2, success: true },
	{ enabled: true, maxRetries: 0, expectedCalls: 1, success: false },
	{ enabled: false, maxRetries: 3, expectedCalls: 1, success: false },
])(
	"compaction retries obey enabled=$enabled and maxRetries=$maxRetries",
	async ({ enabled, maxRetries, expectedCalls, success }) => {
		await using app = await fixture({ enabled, maxRetries, baseDelayMs: 0 });
		const before = (await app.conversation.entries({ order: "ascending" }, 100, undefined, context)).items;
		const calls = app.provider.state.callCount;
		app.provider.setResponses([
			fauxAssistantMessage([], { stopReason: "error", errorMessage: "Service overloaded, try again" }),
			fauxAssistantMessage("Earlier work preserved."),
		]);
		const task = await app.harness.waitForTask(await app.conversation.compact(undefined, context), context);
		expect(app.provider.state.callCount - calls).toBe(expectedCalls);
		if (task.state.outcome.status === "completed") {
			expect(success).toBe(true);
			const submission = task.state.outcome.result.submissionId;
			if (submission === undefined) throw new Error("The successful summary has no placement submission");
			expect(await (await app.harness.submission(submission, context))?.wait(context)).toMatchObject({
				status: "done",
			});
			expect(
				(await app.conversation.entries({}, 100, undefined, context)).items.filter(CompactionEntry.is),
			).toHaveLength(1);
			expect(JSON.stringify((await app.conversation.context(context)).messages)).toContain("Earlier work preserved.");
			expect(await app.harness.snapshot(LiveDoc, app.conversation.id, context)).toEqual({});
		} else {
			expect(success).toBe(false);
			expect(task.state.outcome).toMatchObject({ status: "failed", error: { detail: { reason: "model_error" } } });
			expect((await app.conversation.entries({ order: "ascending" }, 100, undefined, context)).items).toEqual(before);
			expect(app.provider.getPendingResponseCount()).toBe(1);
		}
	},
);

test.each([undefined, { provider: "unavailable", modelId: "missing" }])(
	"manual compaction reports unavailable model %j without consuming a response",
	async (model) => {
		const models = createModels(),
			registry = createRegistry();
		const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
		try {
			const conversation = await harness.root(context, { agent: { model } });
			const task = await harness.waitForTask(await conversation.compact(undefined, context), context);
			expect(task.state.outcome).toMatchObject({ status: "failed", error: { detail: { reason: "no_model" } } });
			expect((await conversation.entries({}, 100, undefined, context)).items).toEqual([]);
		} finally {
			await harness.close(context);
		}
	},
);

test("compacting an empty history completes without requesting a summary", async () => {
	const models = createModels(),
		provider = fauxProvider();
	models.setProvider(provider.provider);
	const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, context);
	try {
		const conversation = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		expect((await harness.waitForTask(await conversation.compact(undefined, context), context)).state.outcome).toEqual({
			status: "completed",
			result: {},
		});
		expect(provider.state.callCount).toBe(0);
		expect(await harness.snapshot(LiveDoc, conversation.id, context)).toEqual({});
	} finally {
		await harness.close(context);
	}
});

test("the first custom summary wins without invoking later hooks or a model", async () => {
	await using app = await fixture();
	const decisions: string[] = [],
		calls = app.provider.state.callCount;
	for (const name of ["first", "later"])
		app.registry.install({
			name,
			hooks: [
				hook(CompactionTask, {
					beforeCompact() {
						decisions.push(name);
						return { summary: `${name} summary` };
					},
				}),
			],
		});
	const task = await app.harness.waitForTask(await app.conversation.compact("Keep decisions", context), context);
	expect(task.state.outcome.status).toBe("completed");
	if (task.state.outcome.status !== "completed" || task.state.outcome.result.submissionId === undefined)
		throw new Error("The custom summary was not placed");
	await (await app.harness.submission(task.state.outcome.result.submissionId, context))?.wait(context);
	expect(decisions).toEqual(["first"]);
	expect(app.provider.state.callCount).toBe(calls);
	expect(JSON.stringify((await app.conversation.context(context)).messages)).toContain("first summary");
});

test("aborting an active summary cancels the request and removes the compaction status", async () => {
	await using app = await fixture();
	const entered = Promise.withResolvers<AbortSignal>();
	app.provider.setResponses([
		async (_input, options) => {
			if (!options?.signal) throw new Error("The summary request has no abort signal");
			entered.resolve(options.signal);
			await awaitWithContext(new Promise<void>(() => {}), withAbortSignal(options.signal, context));
			return fauxAssistantMessage("Must not be committed");
		},
	]);
	const before = (await app.conversation.entries({ order: "ascending" }, 100, undefined, context)).items;
	const id = await app.conversation.compact(undefined, context);
	const signal = await entered.promise;
	await app.conversation.abort(context, { background: true });
	expect(signal.aborted).toBe(true);
	expect((await app.harness.waitForTask(id, context)).state.outcome.status).toBe("aborted");
	expect((await app.conversation.entries({ order: "ascending" }, 100, undefined, context)).items).toEqual(before);
	expect(await app.harness.snapshot(LiveDoc, app.conversation.id, context)).toEqual({});
});
