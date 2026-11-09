import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createModels, fauxAssistantMessage, fauxProvider, Type } from "@axi/ai";
import { InlineCodemodeSandbox, loadQuickJSWasm } from "@axi/codemode";
import { BACKGROUND_CONTEXT as context, withAbortSignal } from "@axi/objects/context";
import { expect, test } from "vitest";
import {
	createRegistry,
	defineTool,
	Harness,
	ToolResultEntry,
	type ConversationId,
	type SubmissionId,
} from "../src/index.ts";
import { idFromNumber } from "../src/ids.ts";
import { CodemodeStoreDoc, createCodemodeExtension } from "../src/codemode/index.ts";
import { openNodeJsonlStorage } from "../src/storage/jsonl/node.ts";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";

for (const { backend, mode } of [
	{ backend: "sqlite", mode: "tools" },
	{ backend: "sqlite", mode: "codemode" },
	{ backend: "jsonl", mode: "tools" },
	{ backend: "jsonl", mode: "codemode" },
])
	test(`${backend} ${mode} recovers after a killed process without repeating a committed tool effect`, async () => {
		const directory = await mkdtemp(join(tmpdir(), "axi-process-recovery-"));
		const child = fork(
			fileURLToPath(new URL("./fixtures/interrupted-run.ts", import.meta.url)),
			[directory, backend, mode],
			{
				execArgv: [],
				stdio: ["ignore", "pipe", "pipe", "ipc"],
			},
		);
		const exited = once(child, "exit");
		let diagnostic = "",
			harness: Harness | undefined;
		const sandbox = mode === "codemode" ? new InlineCodemodeSandbox({ wasm: loadQuickJSWasm() }) : undefined;
		child.stdout?.on("data", () => {});
		child.stderr?.on("data", (data: Buffer) => {
			diagnostic = (diagnostic + data.toString()).slice(-4000);
		});
		try {
			const ready = await Promise.race([
				once(child, "message", { signal: AbortSignal.timeout(10000) }).then(([message]: unknown[]) => message),
				exited.then(() => {
					throw new Error(`Recovery fixture exited before admission: ${diagnostic}`);
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
				throw new Error("Invalid recovery fixture receipt");
			const conversationId = idFromNumber<ConversationId>(ready.conversationId),
				submissionId = idFromNumber<SubmissionId>(ready.submissionId);
			expect(child.kill("SIGKILL")).toBe(true);
			const [, signal] = await exited;
			if (process.platform !== "win32") expect(signal).toBe("SIGKILL");
			expect(await readFile(join(directory, "effects.log"), "utf8")).toBe("effect\n");
			const models = createModels(),
				provider = fauxProvider(),
				registry = createRegistry();
			models.setProvider(provider.provider);
			if (sandbox) registry.install(createCodemodeExtension({ sandbox, models: false }));
			provider.setResponses([fauxAssistantMessage("Recovered answer")]);
			let attempts = 0;
			registry.install({
				name: "crash-tools",
				tools: [
					defineTool({
						name: "effect",
						description: "Record a completed effect",
						parameters: Type.Object({}),
						replay: "safe",
						async execute() {
							throw new Error("Committed tool effect was repeated");
						},
					}),
					defineTool({
						name: "wait",
						description: "Wait for a service",
						replay: "safe",
						parameters: Type.Object({}),
						async execute() {
							attempts++;
							return { output: [{ type: "text", text: "service ready" }] };
						},
					}),
				],
			});
			const storage =
				backend === "sqlite"
					? await openNodeSqliteStorage(join(directory, "session.sqlite"))
					: await openNodeJsonlStorage(directory, context);
			harness = await Harness.open(
				storage,
				{ models, registry, settings: { compaction: { enabled: false } } },
				context,
			);
			expect(provider.state.callCount).toBe(0);
			expect(attempts).toBe(0);
			const conversation = await harness.conversation(conversationId, context);
			if (!conversation) throw new Error("Recovered conversation is missing");
			const receipt = await harness.submission(submissionId, context);
			if (!receipt) throw new Error("Recovered submission is missing");
			expect((await conversation.entries({}, 100, undefined, context)).items.filter(ToolResultEntry.is)).toHaveLength(
				mode === "codemode" ? 0 : 1,
			);
			harness.resume();
			expect(await receipt.wait(withAbortSignal(AbortSignal.timeout(8000), context))).toMatchObject({
				status: "done",
				requestId: "crash-once",
			});
			expect(attempts).toBe(1);
			expect(provider.state.callCount).toBe(1);
			expect(
				(await conversation.submit({ type: "input", content: "Persist and wait", requestId: "crash-once" }, context))
					.id,
			).toBe(submissionId);
			expect((await conversation.entries({}, 100, undefined, context)).items.filter(ToolResultEntry.is)).toHaveLength(
				mode === "codemode" ? 1 : 2,
			);
			if (mode === "codemode")
				expect(await harness.snapshot(CodemodeStoreDoc, conversationId, context)).toEqual({
					values: { answer: { first: "effect committed", second: "service ready" } },
				});
			expect(await readFile(join(directory, "effects.log"), "utf8")).toBe("effect\n");
		} finally {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			await exited;
			await harness?.close(context);
			await sandbox?.close();
			await rm(directory, { recursive: true, force: true });
		}
	}, 20000);
