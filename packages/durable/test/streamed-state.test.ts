import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall, Type } from "@axi/ai";
import { BACKGROUND_CONTEXT as context } from "@axi/objects/context";
import { expect, test } from "vitest";
import {
	AssistantEntry,
	createRegistry,
	defineTool,
	Harness,
	LiveDoc,
	MemoryStorage,
	type LiveState,
} from "../src/index.ts";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";

for (const backend of ["memory", "sqlite"])
	test(`streamed text, thinking and nested arguments remain observable and commit correctly through ${backend}`, async () => {
		const directory = await mkdtemp(join(tmpdir(), "axi-streamed-state-"));
		const models = createModels(),
			registry = createRegistry();
		const provider = fauxProvider({ tokensPerSecond: 1000, tokenSize: { min: 1, max: 1 } });
		models.setProvider(provider.provider);
		const expected = {
			path: "folder/streamed-file.txt",
			content: "The text grows as model arguments arrive.",
			rows: ["first row", "second row"],
			nested: { count: 2, enabled: true },
		};
		const called: unknown[] = [];
		registry.install({
			name: "writer",
			tools: [
				defineTool({
					name: "write",
					description: "Save text",
					parameters: Type.Object({
						path: Type.String(),
						content: Type.String(),
						rows: Type.Array(Type.String()),
						nested: Type.Object({ count: Type.Integer(), enabled: Type.Boolean() }),
					}),
					async execute(args) {
						called.push(args);
						return { output: [{ type: "text", text: "saved" }] };
					},
				}),
			],
		});
		const thinking = "Consider the file location and preserve every character of the output.";
		const explanation = "I will write the requested content now.";
		provider.setResponses([
			fauxAssistantMessage(
				[fauxThinking(thinking), fauxText(explanation), fauxToolCall("write", expected, { id: "write-call" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Saved the file."),
		]);
		const storage =
			backend === "memory" ? new MemoryStorage() : await openNodeSqliteStorage(join(directory, "session.sqlite"));
		const harness = await Harness.open(
			storage,
			{ models, registry, settings: { compaction: { enabled: false }, progress: { partialIntervalMs: 1 } } },
			context,
		);
		try {
			const conversation = await harness.root(context, {
				agent: { model: { provider: provider.provider.id, modelId: provider.getModel().id } },
			});
			const watch = await conversation.watch(context);
			const partials: NonNullable<LiveState["generation"]>["message"][] = [];
			watch.start(async (event) => {
				if (event.kind === "failed") throw event.error;
				const message = (await harness.snapshot(LiveDoc, conversation.id, context))?.generation?.message;
				if (message) partials.push(structuredClone(message));
			});
			try {
				const receipt = await conversation.submit({ type: "input", content: "Write the file" }, context);
				expect(await receipt.wait(context)).toMatchObject({ status: "done" });
				expect(called).toEqual([expected]);
				expect(
					partials.some((message) =>
						message?.content.some(
							(block) =>
								block.type === "thinking" && block.thinking.length > 0 && block.thinking.length < thinking.length,
						),
					),
				).toBe(true);
				expect(
					partials.some((message) =>
						message?.content.some(
							(block) => block.type === "text" && block.text.length > 0 && block.text.length < explanation.length,
						),
					),
				).toBe(true);
				expect(
					partials.some((message) =>
						message?.content.some(
							(block) =>
								block.type === "toolCall" &&
								typeof block.arguments.content === "string" &&
								block.arguments.content.length > 0 &&
								block.arguments.content.length < expected.content.length,
						),
					),
				).toBe(true);
				for (const message of partials)
					for (const block of message?.content ?? []) {
						if (block.type === "thinking") expect(thinking.startsWith(block.thinking)).toBe(true);
						if (block.type === "toolCall" && typeof block.arguments.content === "string")
							expect(expected.content.startsWith(block.arguments.content)).toBe(true);
					}
				const entries = await conversation.entries({}, 100, undefined, context);
				const assistant = entries.items
					.toReversed()
					.filter(AssistantEntry.is)
					.flatMap((entry) => entry.model ?? []);
				expect(assistant).toMatchObject([
					{
						content: [
							{ type: "thinking", thinking },
							{ type: "text", text: explanation },
							{ type: "toolCall", arguments: expected },
						],
					},
					{ content: [{ type: "text", text: "Saved the file." }] },
				]);
				expect(await harness.snapshot(LiveDoc, conversation.id, context)).toEqual({});
			} finally {
				await watch.stop();
			}
		} finally {
			await harness.close(context);
			await rm(directory, { recursive: true, force: true });
		}
	});
