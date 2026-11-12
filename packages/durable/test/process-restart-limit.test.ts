import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createModels, fauxAssistantMessage, fauxProvider, Type } from "@axi/ai";
import { BACKGROUND_CONTEXT as context, withAbortSignal } from "@axi/objects/context";
import { expect, test } from "vitest";
import { idFromNumber } from "../src/ids.ts";
import {
	createRegistry,
	defineTool,
	Harness,
	ToolResultEntry,
	ToolTask,
	type ConversationId,
	type SubmissionId,
} from "../src/index.ts";
import { openNodeJsonlStorage } from "../src/storage/jsonl/node.ts";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";

test.each(["sqlite", "jsonl"] as const)(
	"%s stops a replay-safe tool after two killed attempts and keeps its committed sibling",
	async (backend) => {
		const directory = await mkdtemp(join(tmpdir(), "axi-process-restart-limit-"));
		let admitted: { conversationId: ConversationId; submissionId: SubmissionId } | undefined;
		let harness: Harness | undefined;
		try {
			for (let attempt = 1; attempt <= 2; attempt++) {
				const child = fork(
					fileURLToPath(new URL("./fixtures/interrupted-run.ts", import.meta.url)),
					[directory, backend, "tools", "2"],
					{ execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"] },
				);
				const exited = once(child, "exit");
				let diagnostic = "";
				child.stderr?.on("data", (data: Buffer) => {
					diagnostic = (diagnostic + data.toString()).slice(-4000);
				});
				try {
					const ready = await Promise.race([
						once(child, "message", { signal: AbortSignal.timeout(8000) }).then(([value]: unknown[]) => value),
						exited.then(() => {
							throw new Error(`Interrupted task fixture exited before readiness: ${diagnostic}`);
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
						typeof ready.submissionId !== "number"
					)
						throw new Error("The interrupted task fixture returned an invalid admission");
					const ids = {
						conversationId: idFromNumber<ConversationId>(ready.conversationId),
						submissionId: idFromNumber<SubmissionId>(ready.submissionId),
					};
					if (admitted) expect(ids).toEqual(admitted);
					admitted = ids;
					expect(child.kill("SIGKILL")).toBe(true);
					const [, signal] = await exited;
					if (process.platform !== "win32") expect(signal).toBe("SIGKILL");
					expect(await readFile(join(directory, "attempts.log"), "utf8")).toBe("attempt\n".repeat(attempt));
				} finally {
					if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
					await exited;
				}
			}
			if (!admitted) throw new Error("No submission was admitted");
			const models = createModels(),
				provider = fauxProvider(),
				registry = createRegistry();
			models.setProvider(provider.provider);
			provider.setResponses([fauxAssistantMessage("Recovered after the restart limit")]);
			let repeated = 0;
			registry.install({
				name: "crash-tools",
				tools: ["effect", "wait"].map((name) =>
					defineTool({
						name,
						description: "An operation that must not be repeated",
						parameters: Type.Object({}),
						replay: "safe",
						async execute() {
							repeated++;
							return { output: [] };
						},
					}),
				),
			});
			const storage =
				backend === "sqlite"
					? await openNodeSqliteStorage(join(directory, "session.sqlite"))
					: await openNodeJsonlStorage(directory, context);
			harness = await Harness.open(
				storage,
				{
					models,
					registry,
					settings: { restartLimit: 2, compaction: { enabled: false } },
				},
				context,
			);
			expect((await harness.inspect(context)).scheduling).toBe("paused");
			const receipt = await harness.submission(admitted.submissionId, context);
			if (!receipt) throw new Error("The admitted submission was lost");
			harness.resume();
			expect(await receipt.wait(withAbortSignal(AbortSignal.timeout(8000), context))).toMatchObject({ status: "done" });
			const conversation = await harness.conversation(admitted.conversationId, context);
			if (!conversation) throw new Error("The saved conversation was lost");
			const results = (await conversation.entries({}, 100, undefined, context)).items.filter(ToolResultEntry.is);
			expect(results).toHaveLength(2);
			expect(results.filter((entry) => entry.data?.diagnostics.some((d) => d.code === "restart_limit"))).toHaveLength(
				1,
			);
			const tasks = (await harness.commit((tx) => tx.scanTasks({ kind: ToolTask.definition.name }, 10), context)).items;
			expect(
				tasks.filter((task) => task.state.status === "terminal" && task.state.outcome.status === "failed"),
			).toHaveLength(1);
			expect(repeated).toBe(0);
			expect(provider.state.callCount).toBe(1);
			expect(await readFile(join(directory, "effects.log"), "utf8")).toBe("effect\n");
			expect(await readFile(join(directory, "attempts.log"), "utf8")).toBe("attempt\nattempt\n");
		} finally {
			await harness?.close(context);
			await rm(directory, { recursive: true, force: true });
		}
	},
	25000,
);
