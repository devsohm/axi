import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createModels, fauxProvider } from "@axi/ai";
import { BACKGROUND_CONTEXT as context, withAbortSignal } from "@axi/objects/context";
import { expect, test } from "vitest";
import { idFromNumber } from "../src/ids.ts";
import {
	AssistantEntry,
	createRegistry,
	GenerationTask,
	Harness,
	hook,
	LiveDoc,
	type ConversationId,
	type SubmissionId,
	type TaskId,
} from "../src/index.ts";
import { openNodeJsonlStorage } from "../src/storage/jsonl/node.ts";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { reviewTask } from "./fixtures/after-run-review.ts";

test.each(["sqlite", "jsonl"] as const)(
	"%s resumes a killed after-run child from its saved phase without repeating the answer or hook",
	async (backend) => {
		const directory = await mkdtemp(join(tmpdir(), "axi-after-run-recovery-"));
		const child = fork(
			fileURLToPath(new URL("./fixtures/interrupted-after-run.ts", import.meta.url)),
			[directory, backend],
			{
				execArgv: [],
				stdio: ["ignore", "ignore", "pipe", "ipc"],
			},
		);
		const exited = once(child, "exit");
		let harness: Harness | undefined;
		let diagnostic = "";
		child.stderr?.on("data", (chunk: Buffer) => {
			diagnostic = (diagnostic + chunk.toString()).slice(-4000);
		});
		try {
			const ready: unknown = await Promise.race([
				once(child, "message", { signal: AbortSignal.timeout(8000) }).then(([message]: unknown[]) => message),
				exited.then(() => {
					throw new Error(`Review fixture exited before readiness: ${diagnostic}`);
				}),
			]);
			if (
				!ready ||
				typeof ready !== "object" ||
				!("kind" in ready) ||
				ready.kind !== "ready" ||
				!("conversationId" in ready) ||
				typeof ready.conversationId !== "number" ||
				!("submissionId" in ready) ||
				typeof ready.submissionId !== "number" ||
				!("tasks" in ready) ||
				!Array.isArray(ready.tasks)
			)
				throw new Error("Invalid review fixture readiness");
			expect(ready.tasks).toHaveLength(1);
			const taskIds = ready.tasks.map((id: unknown) => {
				if (typeof id !== "number") throw new Error("Invalid review task ID");
				return idFromNumber<TaskId>(id);
			});
			expect(child.kill("SIGKILL")).toBe(true);
			const [, signal] = await exited;
			if (process.platform !== "win32") expect(signal).toBe("SIGKILL");
			const models = createModels(),
				provider = fauxProvider(),
				registry = createRegistry();
			models.setProvider(provider.provider);
			let hooks = 0,
				finishes = 0;
			const reports: unknown[] = [];
			const Review = reviewTask(async () => {
				finishes++;
			});
			registry.install({
				name: "review",
				tasks: [Review],
				hooks: [
					hook(GenerationTask, {
						afterRun: () => {
							hooks++;
						},
					}),
				],
			});
			const storage =
				backend === "jsonl"
					? await openNodeJsonlStorage(directory, context)
					: await openNodeSqliteStorage(join(directory, "session.sqlite"));
			harness = await Harness.open(storage, { models, registry, onReport: (error) => reports.push(error) }, context);
			const conversation = await harness.conversation(idFromNumber<ConversationId>(ready.conversationId), context);
			if (!conversation) throw new Error("Saved conversation is missing");
			const submission = await harness.submission(idFromNumber<SubmissionId>(ready.submissionId), context);
			expect(await submission?.status(context)).toMatchObject({ status: "done" });
			expect((await harness.inspect(context)).scheduling).toBe("paused");
			expect((await harness.snapshot(LiveDoc, conversation.id, context))?.run?.afterRun?.tasks).toEqual(ready.tasks);
			harness.resume();
			await conversation.waitForIdle(withAbortSignal(AbortSignal.timeout(8000), context));
			const entries = (await conversation.entries({ order: "ascending" }, 100, undefined, context)).items;
			expect(entries.filter(AssistantEntry.is).map((entry) => entry.model)).toEqual([
				[
					expect.objectContaining({
						role: "assistant",
						content: [expect.objectContaining({ type: "text", text: "Answer saved before review" })],
					}),
				],
			]);
			expect(entries.filter((entry) => entry.kind.startsWith("review.")).map((entry) => entry.kind)).toEqual([
				"review.checkpoint",
				"review.finished",
			]);
			for (const id of taskIds) {
				const task = await harness.getTask(id, context);
				expect(task?.state).toMatchObject({ status: "terminal", outcome: { status: "completed" } });
			}
			expect({ hooks, finishes, modelCalls: provider.state.callCount, reports }).toEqual({
				hooks: 0,
				finishes: 1,
				modelCalls: 0,
				reports: [],
			});
			expect((await harness.snapshot(LiveDoc, conversation.id, context))?.run).toBeUndefined();
		} finally {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			await exited;
			await harness?.close(context);
			await rm(directory, { recursive: true, force: true });
		}
	},
	20_000,
);
