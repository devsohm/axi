import { afterEach, describe, expect, it, vi } from "vitest";
import { stream } from "../src/api/google-generative-ai.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"google-generative-ai"> = {
	id: "test-model",
	name: "Test model",
	api: "google-generative-ai",
	provider: "google",
	baseUrl: "https://provider.invalid/v1",
	reasoning: false,
	input: ["text"],
	contextWindow: 10_000,
	maxTokens: 1000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

afterEach(() => vi.unstubAllGlobals());

describe("Google response signatures", () => {
	it.each([{ signature: ["bad"] }, { signature: { length: 1 } }, { signature: { length: -1 } }])(
		"preserves the previous signature after malformed input: $signature",
		async ({ signature }) => {
			vi.stubGlobal("fetch", async () => {
				const chunks = [
					{ candidates: [{ content: { parts: [{ text: "first", thoughtSignature: "c2ln" }] } }] },
					{
						candidates: [
							{ content: { parts: [{ text: "second", thoughtSignature: signature }] }, finishReason: "STOP" },
						],
					},
				];
				return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(""), {
					headers: { "content-type": "text/event-stream" },
				});
			});
			const result = await stream(
				model,
				normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 1 }] }),
				{ apiKey: "test-key", maxRetries: 0 },
			).result();
			expect({ reason: result.stopReason, content: result.content }).toEqual({
				reason: "stop",
				content: [{ type: "text", text: "firstsecond", textSignature: "c2ln" }],
			});
		},
	);
});
