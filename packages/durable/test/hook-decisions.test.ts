import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@axi/ai";
import { BACKGROUND_CONTEXT as context, awaitWithContext } from "@axi/objects/context";
import type { JsonValue } from "@axi/objects/json";
import { expect, test, vi } from "vitest";
import {
	AssistantEntry,
	createRegistry,
	defineExtension,
	defineSignal,
	defineTask,
	defineTool,
	GenerationTask,
	Harness,
	hook,
	LiveDoc,
	MemoryStorage,
	UserEntry,
	type Storage,
} from "../src/index.ts";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";

async function fixture(
	moment: "onYield" | "afterTools",
	decisions: readonly JsonValue[],
	storage: Storage = new MemoryStorage(),
) {
	const models = createModels(),
		provider = fauxProvider(),
		registry = createRegistry();
	models.setProvider(provider.provider);
	const gates = decisions.map(() => Promise.withResolvers<void>());
	const seen: number[] = [],
		reports: unknown[] = [];
	const Decide = defineTask<number, { phase: "decide" }, JsonValue>({
		name: "reviews.decide",
		version: 1,
		initial: () => ({ phase: "decide" }),
		phases: {
			async decide(task, runtime, ctx) {
				seen.push(task.input);
				await awaitWithContext(gates[task.input]!.promise, ctx);
				await runtime.commit(
					() => ({ status: "terminal", outcome: { status: "completed", result: decisions[task.input]! } }),
					ctx,
				);
			},
		},
		abort: (_task, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
	});
	let asked = 0;
	registry.install(
		defineExtension({
			name: "reviews",
			tasks: [Decide],
			tools: [
				defineTool({
					name: "inspect",
					description: "Inspect a work item",
					parameters: Type.Object({}),
					async execute() {
						return { output: [] };
					},
				}),
			],
			hooks: [
				hook(GenerationTask, {
					[moment]: () =>
						++asked === 1 ? { tasks: decisions.map((_, input) => ({ task: Decide, input })) } : undefined,
				}),
			],
		}),
	);
	provider.setResponses(
		moment === "onYield"
			? [fauxAssistantMessage("Draft"), fauxAssistantMessage("Approved answer")]
			: [
					fauxAssistantMessage([fauxToolCall("inspect", {}, { id: "inspection" })], { stopReason: "toolUse" }),
					fauxAssistantMessage("After inspection"),
				],
	);
	const harness = await Harness.open(
		storage,
		{ models, registry, settings: { compaction: { enabled: false } }, onReport: (report) => reports.push(report) },
		context,
	);
	const conversation = await harness.root(context, {
		agent: { model: { provider: provider.provider.id, modelId: provider.getModel().id } },
	});
	return {
		harness,
		conversation,
		gates,
		seen,
		reports,
		async close() {
			for (const gate of gates) gate.resolve();
			await harness.close(context);
		},
	};
}

test.each([true, false])("after-tools decisions terminate the run only when requested (%s)", async (terminate) => {
	const f = await fixture("afterTools", [terminate ? { terminate: true } : null]);
	try {
		const input = await f.conversation.submit({ type: "input", content: "Inspect this" }, context);
		await vi.waitFor(() => expect(f.seen).toEqual([0]), { timeout: 600 });
		expect(await input.status(context)).toMatchObject({ status: "placed" });
		f.gates[0]!.resolve();
		const settled = await input.wait(context);
		expect(settled).toMatchObject({ status: "done" });
		await f.harness.waitForIdle(context);
		const answers = (await f.conversation.entries({ order: "ascending" }, 30, undefined, context)).items.filter(
			AssistantEntry.is,
		);
		expect(answers).toHaveLength(terminate ? 1 : 2);
		expect(f.reports).toEqual([]);
	} finally {
		await f.close();
	}
});

test("answer review waits for all children and uses the first continuation in creation order", async () => {
	const f = await fixture("onYield", [{ continue: "First review" }, { continue: "Second review" }]);
	try {
		const input = await f.conversation.submit({ type: "input", content: "Compose an answer" }, context);
		await vi.waitFor(() => expect(f.seen).toHaveLength(2), { timeout: 600 });
		const live = await f.harness.snapshot(LiveDoc, f.conversation.id, context);
		expect(live?.run?.yield?.tasks).toHaveLength(2);
		expect(await input.status(context)).toMatchObject({ status: "placed" });
		f.gates[1]!.resolve();
		await vi.waitFor(async () =>
			expect(
				(await f.harness.inspect(context)).tasks.filter((task) => task.record.kind === "reviews.decide"),
			).toHaveLength(1),
		);
		expect(await input.status(context)).toMatchObject({ status: "placed" });
		f.gates[0]!.resolve();
		expect(await input.wait(context)).toMatchObject({ status: "done" });
		await f.harness.waitForIdle(context);
		const messages = (await f.conversation.context(context)).messages;
		expect(
			messages.flatMap((message) =>
				typeof message.content === "string"
					? [message.content]
					: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
			),
		).toContain("First review");
		expect(JSON.stringify(messages)).not.toContain("Second review");
	} finally {
		await f.close();
	}
});

test.each(["abort", "followUp"] as const)("a %s during review preserves the committed answer", async (action) => {
	const f = await fixture("onYield", [{ continue: "Discarded review" }]);
	try {
		const input = await f.conversation.submit({ type: "input", content: "Question" }, context);
		await vi.waitFor(() => expect(f.seen).toEqual([0]), { timeout: 600 });
		const answer = (await f.harness.snapshot(LiveDoc, f.conversation.id, context))!.run!.yield!.answer;
		const queued =
			action === "followUp"
				? await f.conversation.submit({ type: "input", content: "New question", whenBusy: "followUp" }, context)
				: undefined;
		if (action === "abort") await f.conversation.abort(context);
		f.gates[0]!.resolve();
		expect(await input.wait(context)).toMatchObject({ status: "done", answer });
		if (queued) expect(await queued.wait(context)).toMatchObject({ status: "done" });
		await f.harness.waitForIdle(context);
		const live = await f.harness.snapshot(LiveDoc, f.conversation.id, context);
		expect(live?.runFailure).toBeUndefined();
		expect(JSON.stringify((await f.conversation.context(context)).messages)).not.toContain("Discarded review");
	} finally {
		await f.close();
	}
});

const invalidAfterTools: JsonValue[] = [false, "terminate", [], { terminate: false }, { terminate: true, extra: 1 }];
test.each(invalidAfterTools)(
	"malformed after-tools decision %j is reported without preventing the next answer",
	async (decision) => {
		const f = await fixture("afterTools", [decision]);
		try {
			const input = await f.conversation.submit({ type: "input", content: "Inspect this" }, context);
			await vi.waitFor(() => expect(f.seen).toEqual([0]), { timeout: 600 });
			f.gates[0]!.resolve();
			expect(await input.wait(context)).toMatchObject({ status: "done" });
			expect(f.reports).toHaveLength(1);
			expect(f.reports[0]).toMatchObject({ kind: "extension_error", extension: "reviews" });
		} finally {
			await f.close();
		}
	},
);

const continuations: { name: string; value: JsonValue; accepted: boolean }[] = [
	{ name: "number", value: 7, accepted: false },
	{ name: "null", value: null, accepted: false },
	{ name: "empty array", value: [], accepted: false },
	{ name: "scalar text block", value: [{ type: "text", text: 7 }], accepted: false },
	{ name: "incomplete image", value: [{ type: "image", data: "AQID" }], accepted: false },
	{ name: "unknown block", value: [{ type: "video", data: "AQID", mimeType: "video/webm" }], accepted: false },
	{ name: "null block", value: [null], accepted: false },
	{ name: "empty text", value: "", accepted: true },
	{ name: "text blocks", value: [{ type: "text", text: "Review notes" }], accepted: true },
	{ name: "image block", value: [{ type: "image", data: "AQID", mimeType: "image/png" }], accepted: true },
];
test.each(continuations)("answer review validates a $name continuation", async ({ value, accepted }) => {
	const f = await fixture("onYield", [{ continue: value }]);
	try {
		const input = await f.conversation.submit({ type: "input", content: "Original question" }, context);
		await vi.waitFor(() => expect(f.seen).toEqual([0]));
		f.gates[0]!.resolve();
		expect(await input.wait(context)).toMatchObject({ status: "done" });
		await f.harness.waitForIdle(context);
		const entries = (await f.conversation.entries({ order: "ascending" }, 30, undefined, context)).items;
		expect(entries.filter(AssistantEntry.is)).toHaveLength(accepted ? 2 : 1);
		const userMessages = entries.filter(UserEntry.is).flatMap((entry) => entry.model ?? []);
		expect(userMessages).toHaveLength(accepted ? 2 : 1);
		if (accepted) expect(userMessages[1]?.content).toEqual(value);
		expect(f.reports).toEqual([]);
		expect(await f.harness.snapshot(LiveDoc, f.conversation.id, context)).toEqual({});
	} finally {
		await f.close();
	}
});

test("an empty after-tools decision continues without an extension error", async () => {
	const f = await fixture("afterTools", [{}]);
	try {
		const input = await f.conversation.submit({ type: "input", content: "Inspect this" }, context);
		await vi.waitFor(() => expect(f.seen).toEqual([0]));
		f.gates[0]!.resolve();
		expect(await input.wait(context)).toMatchObject({ status: "done" });
		await f.harness.waitForIdle(context);
		expect((await f.conversation.entries({}, 30, undefined, context)).items.filter(AssistantEntry.is)).toHaveLength(2);
		expect(f.reports).toEqual([]);
	} finally {
		await f.close();
	}
});

test("a parked answer review reopens from SQLite without asking the hook twice", async () => {
	const directory = await mkdtemp(join(tmpdir(), "axi-answer-review-")),
		path = join(directory, "session.sqlite");
	const models = createModels(),
		provider = fauxProvider(),
		registry = createRegistry();
	models.setProvider(provider.provider);
	const Approved = defineSignal({ name: "reviews.approved", version: 1, schema: Type.Boolean() });
	const Decide = defineTask<null, { phase: "park" | "finish" }, null>({
		name: "reviews.persisted",
		version: 1,
		initial: () => ({ phase: "park" }),
		phases: {
			park: (_task, runtime, ctx) =>
				runtime.commit(
					() => ({ status: "sleeping", checkpoint: { phase: "finish" }, signals: [Approved.key("decision")] }),
					ctx,
				),
			finish: (_task, runtime, ctx) =>
				runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx),
		},
		abort: (_task, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
	});
	let asked = 0;
	registry.install(
		defineExtension({
			name: "reviews",
			tasks: [Decide],
			hooks: [
				hook(GenerationTask, {
					onYield: () => {
						asked++;
						return { tasks: [{ task: Decide, input: null }] };
					},
				}),
			],
		}),
	);
	provider.setResponses([fauxAssistantMessage("Persisted answer")]);
	let harness = await Harness.open(await openNodeSqliteStorage(path), { models, registry }, context);
	try {
		const conversation = await harness.root(context, {
			agent: { model: { provider: provider.provider.id, modelId: provider.getModel().id } },
		});
		const input = await conversation.submit({ type: "input", content: "Review before delivery" }, context);
		await vi.waitFor(
			async () =>
				expect(
					(await harness.inspect(context)).tasks.some(
						(task) => task.record.kind === Decide.definition.name && task.record.state.status === "sleeping",
					),
				).toBe(true),
			{ timeout: 700 },
		);
		const live = (await harness.snapshot(LiveDoc, conversation.id, context))!;
		await harness.close(context);
		harness = await Harness.open(await openNodeSqliteStorage(path), { models, registry }, context);
		await harness.signal(live.run!.yield!.tasks[0]!, Approved, "decision", true, context);
		expect(await (await harness.submission(input.id, context))!.wait(context)).toMatchObject({
			status: "done",
			answer: live.run!.yield!.answer,
		});
		expect(asked).toBe(1);
	} finally {
		await harness.close(context);
		await rm(directory, { recursive: true, force: true });
	}
});
