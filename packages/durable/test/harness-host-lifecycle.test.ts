import { createModels, fauxAssistantMessage, fauxProvider, registerSessionResourceCleanup } from "@axi/ai";
import { awaitWithContext, BACKGROUND_CONTEXT as context, withAbortSignal } from "@axi/objects/context";
import { expect, test } from "vitest";
import {
	AssistantEntry,
	createRegistry,
	defineExtension,
	defineTask,
	Harness,
	MemoryStorage,
	type Report,
	type ConversationHandle,
	type ConversationId,
	type Submission,
	type SubmissionId,
} from "../src/index.ts";

test("the model factory is lazy and a replacement catalog serves the next turn without reopening", async () => {
	const providers = [fauxProvider(), fauxProvider()];
	const catalogs = providers.map((provider) => {
		const models = createModels();
		models.setProvider(provider.provider);
		return models;
	});
	let selected = 0,
		reads = 0;
	providers[0]!.setResponses([fauxAssistantMessage("First catalog")]);
	providers[1]!.setResponses([fauxAssistantMessage("Replacement catalog")]);
	const harness = await Harness.open(
		new MemoryStorage(),
		{
			models: () => {
				reads++;
				return catalogs[selected]!;
			},
			registry: createRegistry(),
			settings: { compaction: { enabled: false } },
		},
		context,
	);
	try {
		expect(reads).toBe(0);
		const conversation = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		for (selected = 0; selected < 2; selected++) {
			const submission = await conversation.submit({ type: "input", content: "Answer" }, context);
			expect(await submission.wait(context)).toMatchObject({ status: "done" });
		}
		await harness.waitForIdle(context);
		const answers = (await conversation.entries({ order: "ascending" }, 30, undefined, context)).items.filter(
			AssistantEntry.is,
		);
		expect(answers.map((entry) => entry.model?.[0]?.content)).toEqual([
			[{ type: "text", text: "First catalog" }],
			[{ type: "text", text: "Replacement catalog" }],
		]);
		expect(providers.map((provider) => provider.state.callCount)).toEqual([1, 1]);
		expect(reads).toBeGreaterThan(0);
	} finally {
		await harness.close(context);
	}
});

test("task conversation handles submit, settle and abort within their invocation and expire together", async () => {
	const models = createModels(),
		provider = fauxProvider(),
		storage = new MemoryStorage(),
		invocationEnded = Promise.withResolvers<void>();
	models.setProvider(provider.provider);
	provider.setResponses([fauxAssistantMessage("Handled")]);
	let target: ConversationId | undefined, handle: ConversationHandle | undefined, submission: Submission | undefined;
	const Task = defineTask<null, { phase: "run" }, null>({
		name: "host.conversation-handle",
		version: 1,
		initial: () => ({ phase: "run" }),
		phases: {
			run: async (_record, api, ctx) => {
				api.signal.addEventListener("abort", () => invocationEnded.resolve(), { once: true });
				if (target === undefined) throw new Error("Target was not configured");
				handle = await api.conversation(target, ctx);
				if (!handle) throw new Error("Target handle was not returned");
				submission = await handle.submit({ type: "input", content: "Answer" }, ctx);
				expect((await submission.status(ctx)).conversationId).toBe(target);
				expect(await submission.wait(ctx)).toMatchObject({ status: "done" });
				expect(await submission.abort(ctx)).toBe("settled");
				await handle.waitForIdle(ctx);
				await handle.abort(ctx);
				await api.commit(
					(tx) =>
						handle!
							.submit(tx, { type: "write", entry: { kind: "handled", data: null } })
							.then(() => ({ status: "terminal", outcome: { status: "completed", result: null } })),
					ctx,
				);
			},
		},
		abort: (_record, api, ctx) => api.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
	});
	const registry = createRegistry();
	registry.install(defineExtension({ name: "host-handles", tasks: [Task] }));
	const harness = await Harness.open(
		storage,
		{ models, registry, settings: { compaction: { enabled: false } } },
		context,
	);
	try {
		const owner = await harness.root(context),
			other = await harness.createConversation(
				{ ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "faux-1" } } },
				context,
			);
		target = other.id;
		const task = await owner.commit(
			(tx) => tx.createTask(Task, null, { ownership: { kind: "conversation" } }),
			context,
		);
		harness.resume();
		expect((await harness.waitForTask(task, context)).state.outcome).toEqual({ status: "completed", result: null });
		await harness.waitForIdle(context);
		await invocationEnded.promise;
		if (!handle || !submission) throw new Error("Invocation did not produce its handles");
		const endedHandle = handle,
			endedSubmission = submission;
		for (const read of [
			() => endedHandle.submit({ type: "input", content: "Late" }, context),
			() => endedHandle.abort(context),
			() => endedHandle.waitForIdle(context),
			() => endedSubmission.status(context),
			() => endedSubmission.wait(context),
			() => endedSubmission.abort(context),
		])
			await expect(read()).rejects.toThrow(/ended|expired|no longer|inactive/);
		expect((await other.entries({}, 20, undefined, context)).items[0]).toMatchObject({ kind: "handled", data: null });
		expect(provider.state.callCount).toBe(1);
	} finally {
		await harness.close(context);
	}
});

test("a registry without built-in tasks fails before storage ownership transfers", async () => {
	class Storage extends MemoryStorage {
		closes = 0;
		override async close(ctx: Parameters<MemoryStorage["close"]>[0]) {
			this.closes++;
			await super.close(ctx);
		}
	}
	const storage = new Storage(),
		registry = createRegistry(),
		base = registry.snapshot();
	await expect(
		Harness.open(
			storage,
			{
				models: createModels(),
				registry: { snapshot: () => ({ ...base, tasks: () => [], task: () => undefined }), subscribe: () => () => {} },
			},
			context,
		),
	).rejects.toThrow("Registry lacks built-in tasks");
	expect(storage.closes).toBe(0);
	const harness = await Harness.open(storage, { models: createModels(), registry }, context);
	await harness.root(context);
	await harness.close(context);
	expect(storage.closes).toBe(1);
});

test("a task scan failure during opening closes the acquired backend and retains the original error", async () => {
	const failure = new Error("Task scan failed");
	class Storage extends MemoryStorage {
		backendClosed = false;
		override async scanTasks(..._args: Parameters<MemoryStorage["scanTasks"]>): ReturnType<MemoryStorage["scanTasks"]> {
			throw failure;
		}
		override async close(ctx: Parameters<MemoryStorage["close"]>[0]) {
			this.backendClosed = true;
			await super.close(ctx);
		}
	}
	const storage = new Storage();
	await expect(Harness.open(storage, { models: createModels(), registry: createRegistry() }, context)).rejects.toBe(
		failure,
	);
	expect(storage.backendClosed).toBe(true);
});

test.each(["subscribe", "unsubscribe"] as const)(
	"a registry %s failure releases storage without replacing the original error",
	async (stage) => {
		const failure = new Error("Registry listener failed"),
			registry = createRegistry(),
			reports: Report[] = [];
		class Storage extends MemoryStorage {
			closes = 0;
			override async close(ctx: Parameters<MemoryStorage["close"]>[0]) {
				this.closes++;
				await super.close(ctx);
			}
		}
		const storage = new Storage();
		const opened = Harness.open(
			storage,
			{
				models: createModels(),
				registry: {
					snapshot: () => registry.snapshot(),
					subscribe(listener) {
						if (stage === "subscribe") throw failure;
						const detach = registry.subscribe(listener);
						return () => {
							detach();
							throw failure;
						};
					},
				},
				onReport: (report) => reports.push(report),
			},
			context,
		);
		if (stage === "subscribe") {
			await expect(opened).rejects.toBe(failure);
		} else {
			const harness = await opened;
			try {
				await harness.root(context);
				await harness.close(context);
				await harness.close(context);
				expect(await harness.closed).toEqual({ kind: "closed" });
				expect(reports).toEqual([{ kind: "host_error", callback: "registry", error: failure }]);
			} finally {
				await harness.close(context);
			}
		}
		expect(storage.closes).toBe(1);
	},
);

test("provider cleanup failure is reported without preventing backend closure", async () => {
	const models = createModels(),
		provider = fauxProvider(),
		reports: Report[] = [];
	models.setProvider(provider.provider);
	const sessions: string[] = [];
	provider.setResponses([
		(_request, options) => {
			if (options?.sessionId) sessions.push(options.sessionId);
			return fauxAssistantMessage("Finished");
		},
	]);
	const cleanup = registerSessionResourceCleanup((id) => {
		if (id && sessions.includes(id)) throw new Error("Transport cleanup failed");
	});
	const storage = new MemoryStorage();
	const harness = await Harness.open(
		storage,
		{ models, registry: createRegistry(), onReport: (report) => reports.push(report) },
		context,
	);
	try {
		const conversation = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		expect(
			await (await conversation.submit({ type: "input", content: "Answer" }, context)).wait(context),
		).toMatchObject({ status: "done" });
		await harness.close(context);
		expect(await harness.closed).toEqual({ kind: "closed" });
		expect(sessions).toHaveLength(1);
		expect(reports).toMatchObject([
			{ kind: "host_error", callback: "models", error: { errors: [{ message: "Transport cleanup failed" }] } },
		]);
	} finally {
		cleanup();
		await harness.close(context);
	}
});

test("a failing host clock is reported once and falls back to a usable clock", async () => {
	const failure = new Error("Host clock failed"),
		reports: Report[] = [];
	const harness = await Harness.open(
		new MemoryStorage(),
		{
			models: createModels(),
			registry: createRegistry(),
			now: () => {
				throw failure;
			},
			onReport: (report) => reports.push(report),
		},
		context,
	);
	try {
		const conversation = await harness.root(context);
		for (let index = 0; index < 3; index++)
			await conversation.commit((tx) => tx.appendEntry(conversation.id, { kind: "clock", data: index }), context);
		expect((await conversation.entries({}, 10, undefined, context)).items.map((entry) => entry.data)).toEqual([
			2, 1, 0,
		]);
		expect(reports).toEqual([{ kind: "host_error", callback: "now", error: failure }]);
	} finally {
		await harness.close(context);
	}
});

test("a declined progress timer is reported while normal task pacing continues", async () => {
	const reports: Report[] = [],
		models = createModels(),
		provider = fauxProvider();
	models.setProvider(provider.provider);
	provider.setResponses([
		fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 temporarily unavailable" }),
		fauxAssistantMessage("Retried"),
	]);
	const harness = await Harness.open(
		new MemoryStorage(),
		{
			models,
			registry: createRegistry(),
			setTimer: () => undefined,
			onReport: (report) => reports.push(report),
			settings: { retry: { maxRetries: 1, baseDelayMs: 1 }, compaction: { enabled: false } },
		},
		context,
	);
	try {
		const conversation = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		expect(
			await (await conversation.submit({ type: "input", content: "Try again" }, context)).wait(context),
		).toMatchObject({ status: "done" });
		expect(provider.state.callCount).toBe(2);
		expect(reports).toEqual(
			expect.arrayContaining([
				{
					kind: "host_error",
					callback: "setTimer",
					error: new Error("HarnessOptions.setTimer declined a timer that paces work; using setTimeout"),
				},
			]),
		);
	} finally {
		await harness.close(context);
	}
});

test("host abort controls distinguish queued, placed, settled and foreign submissions", async () => {
	const models = createModels(),
		provider = fauxProvider(),
		storage = new MemoryStorage();
	models.setProvider(provider.provider);
	const entered = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	provider.setResponses([
		async (_request, options) => {
			entered.resolve();
			await awaitWithContext(release.promise, options?.signal ? withAbortSignal(options.signal, context) : context);
			return fauxAssistantMessage("Finished");
		},
	]);
	const harness = await Harness.open(storage, { models, registry: createRegistry() }, context);
	try {
		const conversation = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		const first = await conversation.submit({ type: "input", content: "First" }, context);
		await entered.promise;
		const queued = await conversation.submit({ type: "input", content: "Queued", whenBusy: "followUp" }, context);
		const foreign = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
		expect((await harness.inspect(context)).submissions.map((submission) => submission.id)).toEqual([
			first.id,
			queued.id,
		]);
		expect(await harness.abortSubmission(queued.id, context, foreign.id)).toBe("not_found");
		expect(await harness.abortSubmission(queued.id, context, conversation.id)).toBe("aborted");
		expect(await harness.abortSubmission(queued.id, context)).toBe("settled");
		expect(await harness.abortSubmission(first.id, context)).toBe("already_placed");
		expect(await harness.abortSubmission(await storage.mintId<SubmissionId>(), context)).toBe("not_found");
		release.resolve();
		expect(await first.wait(context)).toMatchObject({ status: "done" });
		expect(await harness.abortSubmission(first.id, context)).toBe("settled");
	} finally {
		release.resolve();
		await harness.close(context);
	}
});

test("host task abortion settles a sleeping task and its repeated request is terminal", async () => {
	const entered = Promise.withResolvers<void>();
	const Sleep = defineTask<null, { phase: "sleep" }, null>({
		name: "host.sleep",
		version: 1,
		initial: () => ({ phase: "sleep" }),
		phases: {
			sleep: async (_record, api, ctx) => {
				await api.sleepUntil(api.now() + 60_000, { phase: "sleep" }, ctx);
				entered.resolve();
			},
		},
		abort: (_record, api, ctx) => api.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
	});
	const registry = createRegistry();
	registry.install(defineExtension({ name: "sleeper", tasks: [Sleep] }));
	const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry }, context);
	try {
		const conversation = await harness.root(context);
		const id = await conversation.commit(
			(tx) => tx.createTask(Sleep, null, { ownership: { kind: "conversation" } }),
			context,
		);
		harness.resume();
		await entered.promise;
		expect(await harness.abortTask(id, context)).toBe("marked");
		expect((await harness.waitForTask(id, context)).state.outcome).toEqual({ status: "aborted" });
		expect(await harness.abortTask(id, context)).toBe("terminal");
	} finally {
		await harness.close(context);
	}
});
