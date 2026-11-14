import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@axi/ai";
import { BACKGROUND_CONTEXT as context, awaitWithContext, withAbortSignal } from "@axi/objects/context";
import { expect, test } from "vitest";
import {
	AssistantEntry,
	createRegistry,
	defineTask,
	GenerationTask,
	Harness,
	hook,
	hookTask,
	LiveDoc,
	type Report,
} from "../src/index.ts";
import { openNodeJsonlStorage } from "../src/storage/jsonl/node.ts";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { commitWrites } from "../src/testing/commit-writes.ts";

for (const backend of ["sqlite", "jsonl"] as const) {
	test.each(["finish", "drain", "yield"] as const)(
		`${backend} keeps the saved answer when %s recovery reaches its restart limit`,
		async (phase) => {
			const directory = await mkdtemp(join(tmpdir(), "axi-answered-restart-"));
			const openStorage = () =>
				backend === "sqlite"
					? openNodeSqliteStorage(join(directory, "session.sqlite"))
					: openNodeJsonlStorage(directory, context);
			const models = createModels(),
				provider = fauxProvider(),
				registry = createRegistry(),
				reports: Report[] = [];
			const entered = Promise.withResolvers<void>(),
				release = Promise.withResolvers<void>();
			let reopening = false,
				hooks = 0;
			const Review = defineTask<null, { phase: "review" }, null>({
				name: "answer.review",
				version: 1,
				initial: () => ({ phase: "review" }),
				phases: {
					async review(_task, runtime, ctx) {
						if (!reopening) {
							entered.resolve();
							await awaitWithContext(release.promise, ctx);
						}
						await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx);
					},
				},
				abort: (_task, runtime, ctx) =>
					runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
			});
			registry.install({
				name: "answer-review",
				tasks: [Review],
				hooks: [
					hook(GenerationTask, {
						afterRun:
							phase === "yield"
								? undefined
								: async (_run, _runtime, ctx) => {
										hooks++;
										if (phase === "finish") {
											entered.resolve();
											await awaitWithContext(release.promise, ctx);
											return;
										}
										return { tasks: [hookTask(Review, null)] };
									},
						onYield:
							phase !== "yield"
								? undefined
								: () => {
										hooks++;
										return { tasks: [hookTask(Review, null)] };
									},
					}),
				],
			});
			models.setProvider(provider.provider);
			provider.setResponses([fauxAssistantMessage("Persisted answer"), fauxAssistantMessage("Must remain unused")]);
			const options = {
				models,
				registry,
				settings: { restartLimit: 1, compaction: { enabled: false } },
				onReport: (report: Report) => reports.push(report),
			};
			let harness: Harness | undefined;
			try {
				harness = await Harness.open(await openStorage(), options, context);
				const conversation = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
				const input = await conversation.submit({ type: "input", content: "Save this answer" }, context);
				await entered.promise;
				const live = await harness.snapshot(LiveDoc, conversation.id, context);
				if (!live?.run) throw new Error("The answered generation was not retained");
				const generation = live.run.taskId;
				const answers = (await conversation.entries({ order: "ascending" }, 20, undefined, context)).items.filter(
					AssistantEntry.is,
				);
				expect(answers).toHaveLength(1);
				const answer = answers[0]!.id;
				const next = await conversation.submit({ type: "input", content: "Later work", whenBusy: "followUp" }, context);
				expect(await next.status(context)).toMatchObject({ status: "queued" });
				await harness.close(context);
				harness = undefined;
				const storage = await openStorage();
				const saved = await storage.task(generation, context);
				if (!saved || saved.state.status === "terminal" || saved.state.status === "completing")
					throw new Error("The checkpoint was not retained");
				const checkpoint = saved.state.checkpoint;
				if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint) || checkpoint.phase !== phase)
					throw new Error("Unexpected recovery phase");
				await commitWrites(
					storage,
					[{ type: "task", value: { ...saved, restarts: 1, state: { status: "running", checkpoint } } }],
					context,
				);
				reopening = true;
				harness = await Harness.open(storage, options, context);
				expect((await harness.inspect(context)).scheduling).toBe("paused");
				harness.resume();
				const deadline = withAbortSignal(AbortSignal.timeout(5000), context);
				expect((await harness.waitForTask(generation, deadline)).state).toMatchObject({
					status: "terminal",
					outcome: { status: "completed", result: { entryId: answer } },
				});
				expect(await (await harness.submission(input.id, context))?.wait(context)).toMatchObject({
					status: "done",
					answer,
				});
				const resumed = await harness.conversation(conversation.id, context);
				if (!resumed) throw new Error("The saved conversation was lost");
				expect(
					(await resumed.entries({ order: "ascending" }, 100, undefined, context)).items
						.filter(AssistantEntry.is)
						.map((entry) => entry.id),
				).toEqual([answer]);
				expect(await (await harness.submission(next.id, context))?.status(context)).toMatchObject({ status: "queued" });
				const restored = await harness.snapshot(LiveDoc, conversation.id, context);
				expect(restored?.run).toBeUndefined();
				expect(restored?.runFailure).toBeUndefined();
				expect(
					reports.filter((report) => report.kind === "task_interrupted" && report.task.id === generation),
				).toMatchObject([{ reason: "restart_limit" }]);
				expect({ hooks, calls: provider.state.callCount }).toEqual({ hooks: 1, calls: 1 });
			} finally {
				release.resolve();
				await harness?.close(context);
				await rm(directory, { recursive: true, force: true });
			}
		},
	);
}
