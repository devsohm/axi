import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@axi/ai";
import { BACKGROUND_CONTEXT as context } from "@axi/objects/context";
import type { JsonValue } from "@axi/objects/json";
import { expect, test, vi } from "vitest";
import { AssistantEntry, createRegistry, Harness, LiveDoc } from "../src/index.ts";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { commitWrites } from "../src/testing/commit-writes.ts";

for (const phase of ["request", "poll"] as const)
	for (const retry of [false, true])
		test(`reopening an interrupted ${phase} ${retry ? "retries the saved input" : "settles without resending"}`, async () => {
			const directory = await mkdtemp(join(tmpdir(), "axi-interrupted-generation-"));
			const open = () => openNodeSqliteStorage(join(directory, "session.sqlite"));
			const models = createModels(),
				provider = fauxProvider({ deferred: { pollAfterMs: 60000 } }),
				registry = createRegistry();
			models.setProvider(provider.provider);
			provider.setResponses([
				fauxAssistantMessage("Saved deferred answer"),
				fauxAssistantMessage("Fresh retry answer"),
			]);
			const options = {
				models,
				registry,
				settings: {
					stream: { deferred: true },
					retry: { enabled: retry, maxRetries: 1, baseDelayMs: 1 },
					compaction: { enabled: false },
				},
			};
			let harness = await Harness.open(await open(), options, context);
			try {
				const conversation = await harness.root(context, {
					agent: { model: { provider: "faux", modelId: "faux-1" }, thinkingLevel: "high" },
				});
				const receipt = await conversation.submit(
					{ type: "input", content: "Recover this admitted request", requestId: "saved-input" },
					context,
				);
				await vi.waitFor(async () =>
					expect((await harness.snapshot(LiveDoc, conversation.id, context))?.generation?.deferred).toBeDefined(),
				);
				const taskId = (await harness.snapshot(LiveDoc, conversation.id, context))!.run!.taskId;
				await harness.close(context);
				const storage = await open();
				try {
					const task = await storage.task(taskId, context);
					if (task?.state.status !== "sleeping") throw new Error("Expected the persisted deferred request");
					const poll = task.state.checkpoint;
					if (poll === null || typeof poll !== "object" || Array.isArray(poll) || poll.phase !== "poll")
						throw new Error("Expected a poll checkpoint");
					if (poll.model === undefined || poll.cutoff === undefined) throw new Error("Missing saved model request");
					const checkpoint: JsonValue =
						phase === "poll"
							? { ...poll, pollAt: 0 }
							: {
									phase: "request",
									attempt: 1,
									model: poll.model,
									cutoff: poll.cutoff,
									thinkingLevel: "high",
									streamOptions: {},
								};
					await commitWrites(
						storage,
						[{ type: "task", value: { ...task, state: { status: "running", checkpoint } } }],
						context,
					);
				} finally {
					await storage.close(context);
				}
				harness = await Harness.open(
					await open(),
					{ ...options, settings: { ...options.settings, stream: { deferred: false } } },
					context,
				);
				expect((await harness.inspect(context)).scheduling).toBe("paused");
				harness.resume();
				const restored = await harness.submission(receipt.id, context);
				if (!restored) throw new Error("The admitted submission was lost");
				const settled = await restored.wait(context);
				expect(settled).toMatchObject(retry ? { status: "done" } : { status: "unanswered", reason: "interrupted" });
				await harness.waitForIdle(context);
				const resumed = await harness.conversation(conversation.id, context);
				if (!resumed) throw new Error("The conversation was lost");
				expect(
					(await resumed.submit({ type: "input", content: "duplicate", requestId: "saved-input" }, context)).id,
				).toBe(receipt.id);
				const answers = (await resumed.entries({ order: "ascending" }, 100, undefined, context)).items.filter(
					AssistantEntry.is,
				);
				expect(answers).toHaveLength(retry ? 1 : 0);
				if (retry)
					expect(answers[0]!.model?.[0]).toMatchObject({
						content: [{ type: "text", text: phase === "poll" ? "Saved deferred answer" : "Fresh retry answer" }],
					});
				expect(provider.state.callCount).toBe(retry && phase === "request" ? 2 : 1);
				expect(provider.state.cancelledDeferred).toHaveLength(!retry && phase === "poll" ? 1 : 0);
			} finally {
				await harness.close(context);
				await rm(directory, { recursive: true, force: true });
			}
		});
