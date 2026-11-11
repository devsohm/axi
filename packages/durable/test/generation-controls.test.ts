import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type, type TranscriptContext } from "@axi/ai";
import { BACKGROUND_CONTEXT as context, awaitWithContext } from "@axi/objects/context";
import { expect, test } from "vitest";
import {
	createRegistry,
	defineExtension,
	defineTask,
	defineTool,
	GenerationTask,
	Harness,
	hook,
	LiveDoc,
	MemoryStorage,
	ResetEntry,
	ToolResultEntry,
	type EntryId,
	type HookTask,
	type RunSummary,
} from "../src/index.ts";

test.each(["parallel", "sequential"] as const)(
	"%s model tool calls preserve ordering and publish the complete result set to hooks",
	async (mode) => {
		const models = createModels(),
			provider = fauxProvider(),
			registry = createRegistry();
		models.setProvider(provider.provider);
		const started = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
		const released = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
		const events: string[] = [],
			observed: (readonly EntryId[])[] = [];
		const tool = defineTool({
			name: "work",
			description: "Complete an independent work item",
			parameters: Type.Object({ index: Type.Integer({ minimum: 0, maximum: 1 }) }),
			async execute({ index }, _api, ctx) {
				events.push(`start ${index}`);
				started[index]!.resolve();
				await awaitWithContext(released[index]!.promise, ctx);
				events.push(`end ${index}`);
				return { output: [{ type: "text", text: `result ${index}` }] };
			},
		});
		registry.install(
			defineExtension({
				name: "work",
				tools: [tool],
				hooks: [
					hook(GenerationTask, {
						afterTools(_assistant, results) {
							observed.push(results);
						},
					}),
				],
			}),
		);
		provider.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("work", { index: 0 }, { id: "first" }), fauxToolCall("work", { index: 1 }, { id: "second" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("All work complete"),
		]);
		const harness = await Harness.open(
			new MemoryStorage(),
			{ models, registry, settings: { toolExecution: mode, compaction: { enabled: false } } },
			context,
		);
		try {
			const conversation = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
			const receipt = await conversation.submit({ type: "input", content: "Complete both items" }, context);
			await started[0]!.promise;
			if (mode === "parallel") await started[1]!.promise;
			expect(events).toEqual(mode === "parallel" ? ["start 0", "start 1"] : ["start 0"]);
			released[0]!.resolve();
			await started[1]!.promise;
			released[1]!.resolve();
			expect(await receipt.wait(context)).toMatchObject({ status: "done" });
			await harness.waitForIdle(context);
			if (mode === "sequential") expect(events).toEqual(["start 0", "end 0", "start 1", "end 1"]);
			const results = (await conversation.entries({ order: "ascending" }, 100, undefined, context)).items.filter(
				ToolResultEntry.is,
			);
			expect(results.map((entry) => entry.model?.[0])).toMatchObject([
				{ role: "toolResult", toolCallId: "first", content: [{ type: "text", text: "result 0" }] },
				{ role: "toolResult", toolCallId: "second", content: [{ type: "text", text: "result 1" }] },
			]);
			expect(observed).toEqual([results.map((entry) => entry.id)]);
			expect(await harness.snapshot(LiveDoc, conversation.id, context)).toEqual({});
		} finally {
			for (const gate of released) gate.resolve();
			await harness.close(context);
		}
	},
);

test.each([1, 2])("a %i-turn budget stops generation after its final tool result", async (maxTurns) => {
	const models = createModels(),
		provider = fauxProvider(),
		registry = createRegistry();
	models.setProvider(provider.provider);
	let calls = 0;
	registry.install(
		defineExtension({
			name: "count",
			tools: [
				defineTool({
					name: "count",
					description: "Count one item",
					parameters: Type.Object({}),
					async execute() {
						calls++;
						return { output: [] };
					},
				}),
			],
		}),
	);
	provider.setResponses(
		Array.from({ length: maxTurns + 1 }, (_, index) =>
			fauxAssistantMessage([fauxToolCall("count", {}, { id: `step-${index}` })], { stopReason: "toolUse" }),
		),
	);
	const harness = await Harness.open(
		new MemoryStorage(),
		{ models, registry, settings: { compaction: { enabled: false } } },
		context,
	);
	try {
		const conversation = await harness.root(context, {
			agent: { model: { provider: "faux", modelId: "faux-1" }, maxTurns },
		});
		const result = await (await conversation.submit({ type: "input", content: "Keep counting" }, context)).wait(
			context,
		);
		expect(result).toMatchObject({
			status: "unanswered",
			reason: "turn_limit",
			detail: `${maxTurns} ${maxTurns === 1 ? "turn" : "turns"}`,
		});
		expect(calls).toBe(maxTurns);
		expect(provider.state.callCount).toBe(maxTurns);
		expect((await conversation.entries({}, 50, undefined, context)).items.filter(ToolResultEntry.is)).toHaveLength(
			maxTurns,
		);
	} finally {
		await harness.close(context);
	}
});

test("a terminating tool settles the answer without another model call and reports a terminate run boundary", async () => {
	const models = createModels(),
		provider = fauxProvider(),
		registry = createRegistry(),
		summaries: RunSummary[] = [];
	models.setProvider(provider.provider);
	registry.install(
		defineExtension({
			name: "finish",
			tools: [
				defineTool({
					name: "finish",
					description: "Finish the current run",
					parameters: Type.Object({}),
					async execute() {
						return { output: [{ type: "text", text: "Finished" }], control: { terminate: true } };
					},
				}),
			],
			hooks: [
				hook(GenerationTask, {
					afterRun(run) {
						summaries.push(run);
					},
				}),
			],
		}),
	);
	provider.setResponses([
		fauxAssistantMessage([fauxToolCall("finish", {}, { id: "finish" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("unused"),
	]);
	const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
	try {
		const conversation = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		expect(
			await (await conversation.submit({ type: "input", content: "Finish now" }, context)).wait(context),
		).toMatchObject({ status: "done" });
		await harness.waitForIdle(context);
		expect(summaries).toMatchObject([{ reason: "terminate" }]);
		expect(provider.state.callCount).toBe(1);
		expect(provider.getPendingResponseCount()).toBe(1);
	} finally {
		await harness.close(context);
	}
});

test("a model cannot execute a registered tool that was not offered in its request", async () => {
	const models = createModels(),
		provider = fauxProvider(),
		registry = createRegistry();
	models.setProvider(provider.provider);
	let executions = 0;
	const hidden = defineTool({
		name: "hidden",
		description: "Only called by other tools",
		callers: ["tools"],
		parameters: Type.Object({}),
		async execute() {
			executions++;
			return { output: [] };
		},
	});
	registry.install(defineExtension({ name: "private", tools: [hidden] }));
	provider.setResponses([
		fauxAssistantMessage([fauxToolCall("hidden", {}, { id: "attempt" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("Tool was unavailable"),
	]);
	const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
	try {
		const conversation = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		await (await conversation.submit({ type: "input", content: "Try the unavailable tool" }, context)).wait(context);
		const entries = (await conversation.entries({}, 50, undefined, context)).items.filter(ToolResultEntry.is);
		expect(executions).toBe(0);
		expect(entries.map((entry) => entry.model?.[0])).toMatchObject([
			{ role: "toolResult", toolCallId: "attempt", isError: true },
		]);
		expect(JSON.stringify(entries)).toContain("tool_unavailable");
	} finally {
		await harness.close(context);
	}
});

test("tool handoff resets context and exposes a deferred tool for the next request", async () => {
	const models = createModels(),
		provider = fauxProvider(),
		registry = createRegistry();
	const requests: TranscriptContext[] = [];
	models.setProvider(provider.provider);
	const extra = defineTool({
		name: "extra",
		description: "Additional capability",
		deferred: true,
		parameters: Type.Object({}),
		async execute() {
			return { output: [] };
		},
	});
	const discover = defineTool({
		name: "discover",
		description: "Prepare the next stage",
		parameters: Type.Object({}),
		async execute() {
			return { output: [], control: { addTools: ["extra", "extra"], handoff: "Start the next stage" } };
		},
	});
	registry.install(defineExtension({ name: "stages", tools: [discover, extra] }));
	provider.setResponses([
		(request) => {
			requests.push(request);
			return fauxAssistantMessage([fauxToolCall("discover", {}, { id: "discover" })], { stopReason: "toolUse" });
		},
		(request) => {
			requests.push(request);
			return fauxAssistantMessage("Next stage complete");
		},
	]);
	const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
	try {
		const conversation = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		expect(
			await (await conversation.submit({ type: "input", content: "Original stage" }, context)).wait(context),
		).toMatchObject({ status: "done" });
		expect(
			requests.map((request) =>
				request.messages.flatMap((message) =>
					message.role === "system" ? (message.toolsAdded?.map((tool) => tool.name) ?? []) : [],
				),
			),
		).toEqual([["discover"], ["discover", "extra"]]);
		expect(requests[1]!.messages.filter((message) => message.role === "user")).toMatchObject([
			{ content: "Start the next stage" },
		]);
		expect((await conversation.entries({}, 100, undefined, context)).items.filter(ResetEntry.is)).toHaveLength(1);
		expect(provider.state.callCount).toBe(2);
	} finally {
		await harness.close(context);
	}
});

test.each(["builtin", "missing", "phase", "multiple"] as const)(
	"after-run admission reports a %s request without losing the committed answer",
	async (failure) => {
		const models = createModels(),
			provider = fauxProvider(),
			registry = createRegistry(),
			reports: unknown[] = [];
		models.setProvider(provider.provider);
		provider.setResponses([fauxAssistantMessage("Committed answer")]);
		let executions = 0;
		const Invalid = defineTask<null, { phase: string }, null>({
			name: "invalid-start",
			version: 1,
			initial: () => ({ phase: "absent" }),
			phases: {
				async run(_task, runtime, ctx) {
					executions++;
					await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx);
				},
			},
			async abort() {},
		});
		const Missing = defineTask<null, { phase: "run" }, null>({
			name: "uninstalled",
			version: 1,
			initial: () => ({ phase: "run" }),
			phases: {
				async run() {
					executions++;
				},
			},
			async abort() {},
		});
		const choices: Record<typeof failure, HookTask[]> = {
			builtin: [{ task: GenerationTask, input: null }],
			missing: [{ task: Missing, input: null }],
			phase: [{ task: Invalid, input: null }],
			multiple: [
				{ task: Missing, input: null },
				{ task: Invalid, input: null },
			],
		};
		registry.install(
			defineExtension({
				name: "after-run",
				tasks: [Invalid],
				hooks: [
					hook(GenerationTask, {
						afterRun() {
							return { tasks: choices[failure] };
						},
					}),
				],
			}),
		);
		const harness = await Harness.open(
			new MemoryStorage(),
			{ models, registry, onReport: ({ error }) => reports.push(error) },
			context,
		);
		try {
			const conversation = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
			expect(
				await (
					await conversation.submit({ type: "input", content: "Answer with a bad follow-up extension" }, context)
				).wait(context),
			).toMatchObject({ status: "done" });
			await harness.waitForIdle(context);
			expect(reports).toHaveLength(1);
			expect(reports[0]).toBeInstanceOf(failure === "multiple" ? AggregateError : Error);
			if (reports[0] instanceof AggregateError) expect(reports[0].errors).toHaveLength(2);
			expect(executions).toBe(0);
			expect(await harness.snapshot(LiveDoc, conversation.id, context)).toEqual({});
			expect(provider.state.callCount).toBe(1);
		} finally {
			await harness.close(context);
		}
	},
);
