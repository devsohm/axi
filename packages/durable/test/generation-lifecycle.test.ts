import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@axi/ai";
import { BACKGROUND_CONTEXT as context } from "@axi/chord/context";
import { expect, test, vi } from "vitest";
import {
	AssistantEntry,
	createRegistry,
	Harness,
	LiveDoc,
	MemoryStorage,
	type HarnessSettings,
	type ReportInfo,
} from "../src/index.ts";
import { openNodeJsonlStorage } from "../src/storage/jsonl/node.ts";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";

function setup(settings: HarnessSettings = {}, providerOptions: Parameters<typeof fauxProvider>[0] = {}) {
	const models = createModels(),
		provider = fauxProvider(providerOptions),
		registry = createRegistry();
	models.setProvider(provider.provider);
	return {
		models,
		provider,
		options: { models, registry, settings: { compaction: { enabled: false }, ...settings } },
		model: { provider: provider.provider.id, modelId: provider.getModel().id },
	};
}
const serviceError = () =>
	fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 temporarily unavailable" });

for (const recover of [true, false])
	test(`generation ${recover ? "recovers after" : "exhausts"} a bounded durable retry`, async () => {
		const f = setup({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } });
		f.provider.setResponses([
			serviceError(),
			recover ? fauxAssistantMessage("Recovered answer") : serviceError(),
			fauxAssistantMessage("unused"),
		]);
		const harness = await Harness.open(new MemoryStorage(), f.options, context);
		try {
			const conversation = await harness.root(context, { agent: { model: f.model } });
			const receipt = await (await conversation.submit({ type: "input", content: "Try this request" }, context)).wait(
				context,
			);
			expect(receipt).toMatchObject(
				recover
					? { status: "done" }
					: { status: "unanswered", reason: "model_error", detail: "503 temporarily unavailable" },
			);
			const entries = await conversation.entries({}, 100, undefined, context);
			const messages = entries.items
				.toReversed()
				.filter(AssistantEntry.is)
				.flatMap((entry) => entry.model ?? []);
			expect(messages.map((message) => (message.role === "assistant" ? message.stopReason : message.role))).toEqual([
				"error",
				recover ? "stop" : "error",
			]);
			expect(f.provider.state.callCount).toBe(2);
			expect(f.provider.getPendingResponseCount()).toBe(1);
			expect(await harness.snapshot(LiveDoc, conversation.id, context)).toEqual({});
		} finally {
			await harness.close(context);
		}
	});

test("a missing model settles the request and configuring a usable model restores generation", async () => {
	const f = setup(),
		harness = await Harness.open(new MemoryStorage(), f.options, context);
	try {
		const conversation = await harness.root(context);
		expect(
			await (await conversation.submit({ type: "input", content: "No model yet" }, context)).wait(context),
		).toMatchObject({ status: "unanswered", reason: "no_model" });
		await conversation.configure({ model: { provider: f.model.provider, modelId: "absent" } }, context);
		expect(
			await (await conversation.submit({ type: "input", content: "Missing model" }, context)).wait(context),
		).toMatchObject({ status: "unanswered", reason: "no_model" });
		await conversation.configure({ model: f.model }, context);
		f.provider.setResponses([fauxAssistantMessage("Ready now")]);
		expect(
			await (await conversation.submit({ type: "input", content: "Configured" }, context)).wait(context),
		).toMatchObject({ status: "done" });
		expect(f.provider.state.callCount).toBe(1);
	} finally {
		await harness.close(context);
	}
});

for (const policy of ["keep", "continue", "withdraw"] as const)
	test(`failed generation applies the ${policy} policy to queued follow-ups`, async () => {
		const f = setup({ retry: { enabled: false }, afterFailedRun: policy });
		const entered = Promise.withResolvers<void>(),
			release = Promise.withResolvers<void>();
		f.provider.setResponses([
			async () => {
				entered.resolve();
				await release.promise;
				return serviceError();
			},
			fauxAssistantMessage("Follow-up answer"),
		]);
		const harness = await Harness.open(new MemoryStorage(), f.options, context);
		try {
			const conversation = await harness.root(context, { agent: { model: f.model } });
			const first = await conversation.submit({ type: "input", content: "First request" }, context);
			await entered.promise;
			const next = await conversation.submit(
				{ type: "input", content: "Second request", whenBusy: "followUp" },
				context,
			);
			expect(await next.status(context)).toMatchObject({ status: "queued" });
			release.resolve();
			expect(await first.wait(context)).toMatchObject({ status: "unanswered", reason: "model_error" });
			await harness.waitForIdle(context);
			if (policy === "continue") {
				expect(await next.wait(context)).toMatchObject({ status: "done" });
				expect(f.provider.state.callCount).toBe(2);
			} else if (policy === "withdraw") {
				expect(await next.wait(context)).toMatchObject({ status: "unanswered", reason: "run_failed" });
				expect(f.provider.state.callCount).toBe(1);
			} else {
				expect(await next.status(context)).toMatchObject({ status: "queued" });
				expect(await next.abort(context)).toBe("aborted");
				expect(f.provider.state.callCount).toBe(1);
			}
		} finally {
			release.resolve();
			await harness.close(context);
		}
	});

test("deferred generation polls its receipt and commits only the final assistant response", async () => {
	const f = setup({ stream: { deferred: true } }, { deferred: { pendingFetches: 2, pollAfterMs: 1 } });
	f.provider.setResponses([fauxAssistantMessage("Deferred answer")]);
	const harness = await Harness.open(new MemoryStorage(), f.options, context);
	try {
		const conversation = await harness.root(context, { agent: { model: f.model } });
		expect(
			await (await conversation.submit({ type: "input", content: "Run in background" }, context)).wait(context),
		).toMatchObject({ status: "done" });
		expect(f.provider.state.callCount).toBe(1);
		expect(f.provider.state.deferredFetchCount).toBe(3);
		const entries = await conversation.entries({}, 100, undefined, context);
		expect(entries.items.filter(AssistantEntry.is).flatMap((entry) => entry.model ?? [])).toMatchObject([
			{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Deferred answer" }] },
		]);
		expect(await harness.snapshot(LiveDoc, conversation.id, context)).toEqual({});
	} finally {
		await harness.close(context);
	}
});

test("aborting a deferred generation cancels the provider receipt and clears the live run", async () => {
	const f = setup({ stream: { deferred: true } }, { deferred: { pendingFetches: 2, pollAfterMs: 60000 } });
	f.provider.setResponses([fauxAssistantMessage("Must not finish")]);
	const harness = await Harness.open(new MemoryStorage(), f.options, context);
	try {
		const conversation = await harness.root(context, { agent: { model: f.model } });
		const submission = await conversation.submit({ type: "input", content: "Cancelable background job" }, context);
		await vi.waitFor(async () =>
			expect((await harness.snapshot(LiveDoc, conversation.id, context))?.generation?.deferred?.pollAt).toBeTypeOf(
				"number",
			),
		);
		await conversation.abort(context);
		expect(await submission.wait(context)).toMatchObject({ status: "unanswered", reason: "aborted" });
		expect(f.provider.state.cancelledDeferred).toMatchObject([
			{ provider: f.model.provider, modelId: f.model.modelId },
		]);
		expect(f.provider.state.deferredFetchCount).toBe(0);
		expect(await harness.snapshot(LiveDoc, conversation.id, context)).toEqual({});
	} finally {
		await harness.close(context);
	}
});

test("an unavailable optional environment is reported without discarding a valid model answer", async () => {
	const f = setup(),
		reports: { message: string; info: ReportInfo }[] = [];
	f.provider.setResponses([fauxAssistantMessage("No filesystem needed")]);
	const harness = await Harness.open(
		new MemoryStorage(),
		{
			...f.options,
			env: async () => {
				throw new Error("Environment offline");
			},
			onReport: (error, info) =>
				reports.push({ message: error instanceof Error ? error.message : String(error), info }),
		},
		context,
	);
	try {
		const conversation = await harness.root(context, { agent: { model: f.model } });
		expect(
			await (await conversation.submit({ type: "input", content: "Say hello" }, context)).wait(context),
		).toMatchObject({ status: "done" });
		expect(reports).toMatchObject([{ message: "Environment offline", info: { type: "host_error", callback: "env" } }]);
		expect(f.provider.state.callCount).toBe(1);
	} finally {
		await harness.close(context);
	}
});

for (const backend of ["jsonl", "sqlite"] as const)
	test(`${backend} resumes a committed retry after reopening without resubmitting input`, async () => {
		const directory = await mkdtemp(join(tmpdir(), "axi-generation-retry-"));
		const open = () =>
			backend === "jsonl"
				? openNodeJsonlStorage(directory, context)
				: openNodeSqliteStorage(join(directory, "session.sqlite"));
		const f = setup({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 60000 } });
		f.provider.setResponses([serviceError(), fauxAssistantMessage("Recovered after reopen")]);
		let clock = 1000;
		const options = { ...f.options, now: () => clock };
		let harness = await Harness.open(await open(), options, context);
		try {
			const conversation = await harness.root(context, { agent: { model: f.model } });
			const submission = await conversation.submit(
				{ type: "input", content: "Persist my retry", requestId: "one-logical-request" },
				context,
			);
			await vi.waitFor(async () =>
				expect((await harness.snapshot(LiveDoc, conversation.id, context))?.generation?.retry?.at).toBe(61000),
			);
			await harness.close(context);
			clock = 62000;
			harness = await Harness.open(await open(), options, context);
			harness.resume();
			const restored = await harness.submission(submission.id, context);
			if (!restored) throw new Error("Committed submission was lost");
			expect(await restored.wait(context)).toMatchObject({ status: "done", requestId: "one-logical-request" });
			expect(f.provider.state.callCount).toBe(2);
			const reopened = await harness.conversation(conversation.id, context);
			if (!reopened) throw new Error("Conversation was lost");
			const entries = await reopened.entries({}, 100, undefined, context);
			expect(
				entries.items.flatMap((entry) => entry.model ?? []).filter((message) => message.role === "user"),
			).toHaveLength(1);
		} finally {
			await harness.close(context);
			await rm(directory, { force: true, recursive: true });
		}
	});
