import { createModels, type Usage } from "@axi/ai";
import { BACKGROUND_CONTEXT as context } from "@axi/objects/context";
import { expect, test } from "vitest";
import { createRegistry, Harness, MemoryStorage, UsageDoc, type ConversationId } from "../src/index.ts";

test("usage sums every conversation page, preserves special tool names and returns detached totals", async () => {
	const unit: Usage = {
		input: 3,
		output: 2,
		cacheRead: 1,
		cacheWrite: 4,
		totalTokens: 10,
		cacheWrite1h: 2,
		reasoning: 1,
		cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
	};
	const total: Usage = {
		input: 771,
		output: 514,
		cacheRead: 257,
		cacheWrite: 1028,
		totalTokens: 2570,
		cacheWrite1h: 514,
		reasoning: 257,
		cost: { input: 257, output: 514, cacheRead: 771, cacheWrite: 1028, total: 2570 },
	};
	const harness = await Harness.open(
		new MemoryStorage(),
		{ models: createModels(), registry: createRegistry() },
		context,
	);
	try {
		expect(await harness.usage(context)).toEqual({ models: {}, tools: {} });
		const first = await harness.commit(async (tx) => {
			let first: ConversationId | undefined;
			for (let index = 0; index < 257; index++) {
				const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
				first ??= conversation.id;
				const usage = await tx.doc(UsageDoc, conversation.id);
				usage.models["local/model"] = structuredClone(unit);
				usage.tools["__proto__"] = structuredClone(unit);
			}
			if (first === undefined) throw new Error("No conversations were created");
			return first;
		}, context);
		const expected = { models: { "local/model": total }, tools: Object.fromEntries([["__proto__", total]]) };
		const summed = await harness.usage(context);
		expect(summed).toEqual(expected);
		expect(Object.getPrototypeOf(summed.tools)).toBe(Object.prototype);
		expect(Object.hasOwn(summed.tools, "__proto__")).toBe(true);
		summed.models["local/model"]!.input = -1;
		summed.tools["__proto__"]!.cost.total = -1;
		expect(await harness.usage(context)).toEqual(expected);
		expect(await harness.snapshot(UsageDoc, first, context)).toEqual({
			models: { "local/model": unit },
			tools: Object.fromEntries([["__proto__", unit]]),
		});
	} finally {
		await harness.close(context);
	}
});
