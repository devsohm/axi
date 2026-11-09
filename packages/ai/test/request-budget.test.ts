import { expect, test } from "vitest";
import { buildBaseOptions, clampMaxTokensToContext } from "../src/api/simple-options.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"openai-completions"> = {
	id: "budget",
	name: "Budget",
	api: "openai-completions",
	provider: "local",
	baseUrl: "http://localhost",
	input: ["text"],
	reasoning: false,
	contextWindow: 200000,
	maxTokens: 150000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

test("output budgets retain tokenizer headroom without consuming the final answer allowance", () => {
	for (const [contextWindow, input, expected] of [
		[200000, 100000, 85000],
		[200000, 180000, 15904],
		[500000, 450000, 32768],
	] as const) {
		const context = normalizeContext({ messages: [{ role: "user", content: "x".repeat(input * 3.5), timestamp: 1 }] });
		expect(clampMaxTokensToContext({ ...model, contextWindow }, context, model.maxTokens)).toBe(expected);
	}
});

test("simple options forward the request-scoped continuation switch", () => {
	expect(
		buildBaseOptions(model, normalizeContext({ messages: [] }), { disableContinuation: true }).disableContinuation,
	).toBe(true);
});
