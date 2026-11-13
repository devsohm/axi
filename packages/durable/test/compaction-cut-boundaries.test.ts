import { createModels, fauxAssistantMessage, fauxToolCall, type Message } from "@axi/ai";
import { BACKGROUND_CONTEXT as context } from "@axi/objects/context";
import { expect, test } from "vitest";
import { createRegistry, Harness, MemoryStorage } from "../src/index.ts";
import { selectCut } from "../src/harness/compaction.ts";

test.each(["matching-result", "unrelated-result", "new-assistant"] as const)(
	"compaction chooses a complete conversation boundary across %s",
	async (mode) => {
		const harness = await Harness.open(
			new MemoryStorage(),
			{ models: createModels(), registry: createRegistry() },
			context,
		);
		try {
			const conversation = await harness.root(context);
			const contributions: Message[][] = [
				[{ role: "user", content: "old history ".repeat(100), timestamp: 1 }],
				[fauxAssistantMessage([fauxToolCall("read", {}, { id: "pending" })], { stopReason: "toolUse" })],
				[{ role: "user", content: "intervening input ".repeat(100), timestamp: 2 }],
				...(mode === "new-assistant" ? [[fauxAssistantMessage("New assistant response")]] : []),
				[
					{
						role: "toolResult",
						toolCallId: mode === "unrelated-result" ? "another-call" : "pending",
						toolName: "read",
						content: [{ type: "text", text: "completed" }],
						isError: false,
						timestamp: 3,
					},
				],
				[fauxAssistantMessage("Final response")],
			];
			await conversation.commit(async (tx) => {
				for (const model of contributions) await tx.appendEntry(conversation.id, { kind: "boundary", model });
			}, context);
			const view = await conversation.context(context);
			expect(view.contributions).toEqual(contributions);
			expect(selectCut(view, 100)).toBe(mode === "matching-result" ? 4 : 2);
		} finally {
			await harness.close(context);
		}
	},
);
