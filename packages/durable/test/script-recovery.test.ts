import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@axi/ai";
import { BACKGROUND_CONTEXT as context } from "@axi/chord/context";
import { CodemodeSandbox } from "@axi/codemode";
import { Type } from "typebox";
import { expect, test } from "vitest";
import { CodemodeStoreDoc, createCodemodeExtension } from "../src/codemode/index.ts";
import { createRegistry, defineTool, Harness, ToolResultEntry } from "../src/index.ts";
import { openNodeJsonlStorage } from "../src/storage/jsonl/node.ts";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";

for (const backend of ["jsonl", "sqlite"] as const)
	test(`${backend} restores script globals and completed tool results without repeating effects`, async () => {
		const directory = await mkdtemp(join(tmpdir(), "axi-script-recovery-"));
		const open = () =>
			backend === "jsonl"
				? openNodeJsonlStorage(directory, context)
				: openNodeSqliteStorage(join(directory, "session.sqlite"));
		const models = createModels(),
			chat = fauxProvider();
		models.setProvider(chat.provider);
		const entered = Promise.withResolvers<void>();
		let paused = true,
			completed = 0,
			globals = 0,
			attempts = 0;
		function registry(sandbox: CodemodeSandbox) {
			const result = createRegistry();
			result.install(
				createCodemodeExtension({
					sandbox,
					models: false,
					globals: [
						{
							name: "nonce",
							async execute() {
								return ++globals;
							},
						},
					],
				}),
			);
			result.install({
				name: "recovery-tools",
				tools: [
					defineTool({
						name: "effect",
						description: "Record a completed operation",
						parameters: Type.Object({}),
						async execute() {
							completed++;
							return { output: [{ type: "text", text: "effect saved" }] };
						},
					}),
					defineTool({
						name: "wait_ready",
						description: "Wait until the service is ready",
						parameters: Type.Object({}),
						replay: "safe",
						async execute(_args, _api, frame) {
							attempts++;
							if (paused) {
								const signal = frame.abortSignal;
								if (!signal) throw new Error("Tool cancellation signal missing");
								entered.resolve();
								await new Promise<never>((_resolve, reject) => {
									if (signal.aborted) reject(signal.reason);
									else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
								});
							}
							return { output: [{ type: "text", text: "ready" }] };
						},
					}),
				],
			});
			return result;
		}
		chat.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall(
						"codemode",
						{
							code: 'const id = await nonce(); const effect = await tools.effect({}); await tools.wait_ready({}); store("receipt", {id, effect}); return {id, effect};',
						},
						{ id: "recover-script" },
					),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Completed after restart"),
		]);
		let sandbox = new CodemodeSandbox();
		let harness = await Harness.open(await open(), { models, registry: registry(sandbox) }, context);
		try {
			const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
			const receipt = await root.submit(
				{ type: "input", content: "Persist this operation", requestId: "recover-once" },
				context,
			);
			await entered.promise;
			expect({ completed, globals, attempts }).toEqual({ completed: 1, globals: 1, attempts: 1 });
			expect(await harness.snapshot(CodemodeStoreDoc, root.id, context)).toEqual({ values: {} });
			await harness.close(context);
			await sandbox.close();
			paused = false;
			sandbox = new CodemodeSandbox();
			harness = await Harness.open(await open(), { models, registry: registry(sandbox) }, context);
			harness.resume();
			const restored = await harness.submission(receipt.id, context);
			if (!restored) throw new Error("Submission missing after restart");
			expect(await restored.wait(context)).toMatchObject({ status: "done", requestId: "recover-once" });
			expect({ completed, globals, attempts }).toEqual({ completed: 1, globals: 1, attempts: 2 });
			expect(await harness.snapshot(CodemodeStoreDoc, root.id, context)).toEqual({
				values: { receipt: { id: 1, effect: "effect saved" } },
			});
			const conversation = await harness.conversation(root.id, context);
			if (!conversation) throw new Error("Conversation missing after restart");
			const results = (await conversation.entries({}, 100, undefined, context)).items
				.filter(ToolResultEntry.is)
				.flatMap((entry) => entry.model ?? []);
			const script = results.find(
				(message) => message.role === "toolResult" && message.toolCallId === "recover-script",
			);
			if (script?.role !== "toolResult") throw new Error("Recovered script result missing");
			expect(script.isError).toBe(false);
			expect(script.content).toContainEqual({
				type: "text",
				text: expect.stringContaining('{"id":1,"effect":"effect saved"}'),
			});
			expect(chat.state.callCount).toBe(2);
		} finally {
			await harness.close(context);
			await sandbox.close();
			await rm(directory, { recursive: true, force: true });
		}
	});
