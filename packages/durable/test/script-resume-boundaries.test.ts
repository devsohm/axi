import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@axi/ai";
import { InlineCodemodeSandbox, loadQuickJSWasm } from "@axi/codemode";
import { BACKGROUND_CONTEXT as context, awaitWithContext } from "@axi/objects/context";
import { expect, test } from "vitest";
import { CodemodeRunDoc, CodemodeStoreDoc, createCodemodeExtension } from "../src/codemode/codemode.ts";
import { createRegistry, Harness, ToolResultEntry, type TaskId } from "../src/index.ts";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";

test.each(["version", "deadline", "fingerprint", "completed"] as const)(
	"script recovery handles a persisted %s boundary without repeating its host effect",
	async (boundary) => {
		const directory = await mkdtemp(join(tmpdir(), "axi-script-boundary-"));
		const open = () => openNodeSqliteStorage(join(directory, "session.sqlite"));
		const models = createModels(),
			provider = fauxProvider();
		models.setProvider(provider.provider);
		const entered = Promise.withResolvers<TaskId>(),
			waiting = Promise.withResolvers<void>();
		let calls = 0;
		function registry(sandbox: InlineCodemodeSandbox) {
			const registry = createRegistry();
			registry.install(
				createCodemodeExtension({
					sandbox,
					models: false,
					globals: [
						{
							name: "waitForService",
							async execute(_input, api, frame) {
								calls++;
								entered.resolve(api.taskId);
								await awaitWithContext(waiting.promise, frame);
								return "ready";
							},
						},
					],
				}),
			);
			return registry;
		}
		provider.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall(
						"codemode",
						{ code: 'store("candidate", 99); await waitForService(); return "complete";' },
						{ id: "saved-script" },
					),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Recovery handled"),
		]);
		let sandbox = new InlineCodemodeSandbox({ wasm: loadQuickJSWasm() });
		let harness = await Harness.open(await open(), { models, registry: registry(sandbox) }, context);
		try {
			const conversation = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
			const receipt = await conversation.submit(
				{ type: "input", content: "Wait for the service", requestId: "boundary" },
				context,
			);
			const taskId = await entered.promise;
			await harness.commit(async (tx) => {
				const run = await tx.doc(CodemodeRunDoc, taskId);
				if (!run.start) throw new Error("Script start record was not persisted");
				if (boundary === "version") run.start.version = -1;
				else if (boundary === "deadline") run.start.deadline = 0;
				else if (boundary === "fingerprint") run.start.fingerprint = "another-runtime";
				else run.result = { output: [{ type: "text", text: "Previously committed result" }] };
			}, context);
			await harness.close(context);
			await sandbox.close();
			sandbox = new InlineCodemodeSandbox({ wasm: loadQuickJSWasm() });
			harness = await Harness.open(await open(), { models, registry: registry(sandbox) }, context);
			harness.resume();
			const restored = await harness.submission(receipt.id, context);
			if (!restored) throw new Error("Admitted script submission was lost");
			expect(await restored.wait(context)).toMatchObject({ status: "done" });
			await harness.waitForIdle(context);
			const resumed = await harness.conversation(conversation.id, context);
			if (!resumed) throw new Error("Saved conversation was lost");
			const results = (await resumed.entries({}, 100, undefined, context)).items
				.filter(ToolResultEntry.is)
				.flatMap((entry) => entry.model ?? []);
			const result = results.find((message) => message.role === "toolResult" && message.toolCallId === "saved-script");
			if (result?.role !== "toolResult") throw new Error("Script recovery did not publish a result");
			expect(result.isError).toBe(boundary !== "completed");
			expect(JSON.stringify(result.content)).toMatch(
				boundary === "completed"
					? /Previously committed result/
					: boundary === "version"
						? /version/
						: boundary === "deadline"
							? /deadline/
							: /sandbox changed/,
			);
			expect(calls).toBe(1);
			expect(await harness.snapshot(CodemodeStoreDoc, conversation.id, context)).toEqual({ values: {} });
		} finally {
			waiting.resolve();
			await harness.close(context);
			await sandbox.close();
			await rm(directory, { recursive: true, force: true });
		}
	},
);
