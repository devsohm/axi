import { getEventListeners } from "node:events";
import { expect, it } from "vitest";
import { fauxAssistantMessage } from "../src/providers/faux.ts";
import { isRetryableAssistantError, retryAssistantCall } from "../src/utils/retry.ts";

it.each([
	["HTTP 503 temporarily unavailable", true],
	["stream disconnected before completion", true],
	["Request id a503b failed", false],
	["Input has 150000 bytes", false],
	["429 subscription_sharing_workplace_individual_usage_limit_exceeded", false],
] as const)("classifies retries for %s", (errorMessage, expected) => {
	expect(isRetryableAssistantError(fauxAssistantMessage([], { stopReason: "error", errorMessage }))).toBe(expected);
});

it("keeps a completed backoff cancellation listener until the operation aborts", async () => {
	const controller = new AbortController();
	const response = fauxAssistantMessage([]);
	let calls = 0;
	try {
		const result = await retryAssistantCall(
			async () =>
				++calls === 1 ? fauxAssistantMessage([], { stopReason: "error", errorMessage: "server_busy" }) : response,
			{ enabled: true, maxRetries: 1, baseDelayMs: 0 },
			controller.signal,
		);
		expect(result).toBe(response);
		expect(calls).toBe(2);
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
	} finally {
		controller.abort();
	}
	expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
});
