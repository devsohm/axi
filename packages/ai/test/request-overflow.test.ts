import { expect, it } from "vitest";
import type { AssistantMessage } from "../src/types.ts";
import { isContextOverflow } from "../src/utils/overflow.ts";

function response(errorMessage: string): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-completions",
		provider: "github-copilot",
		model: "test",
		content: [],
		timestamp: 0,
		stopReason: "error",
		errorMessage,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

it("classifies HTTP 413 as request overflow without relying on the response body", () => {
	expect(
		isContextOverflow(response('github-copilot API error (413): {"message":"failed to parse request","code":""}')),
	).toBe(true);
	expect(isContextOverflow(response("413 Request Entity Too Large"))).toBe(true);
});

it("does not treat a status code mentioned inside another error as overflow", () => {
	expect(isContextOverflow(response('provider API error (400): {"message":"upstream returned 413"}'))).toBe(false);
	expect(isContextOverflow(response("4130 unrelated error"))).toBe(false);
});
