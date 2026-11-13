import { afterEach, expect, test, vi } from "vitest";
import { fauxAssistantMessage } from "../src/index.ts";
import { isRetryableAssistantError, retryAssistantCall } from "../src/utils/retry.ts";

afterEach(() => vi.useRealTimers());

test.each([
	"ECONNRESET",
	"read ECONNABORTED",
	"write EPIPE",
	"connect ECONNREFUSED 127.0.0.1:443",
	"connect ETIMEDOUT 192.0.2.1:443",
	"connection reset by peer",
	"Peer returned (econnreset).",
])("a transport failure can be retried when it reports %s", (errorMessage) => {
	expect(isRetryableAssistantError(fauxAssistantMessage([], { stopReason: "error", errorMessage }))).toBe(true);
});

test.each(["field EXECONNRESET", "field ETIMEDOUTX", "field ERR_EPIPE_ID", "billing failed: ECONNRESET"])(
	"identifier and terminal failures do not become retryable: %s",
	(errorMessage) => {
		expect(isRetryableAssistantError(fauxAssistantMessage([], { stopReason: "error", errorMessage }))).toBe(false);
	},
);

test("a socket failure retries the provider call and returns the recovered answer", async () => {
	vi.useFakeTimers();
	const answer = fauxAssistantMessage("Recovered");
	let calls = 0;
	const running = retryAssistantCall(
		async () =>
			++calls === 1 ? fauxAssistantMessage([], { stopReason: "error", errorMessage: "read ECONNRESET" }) : answer,
		{ enabled: true, maxRetries: 1, baseDelayMs: 10 },
		undefined,
	);
	await vi.advanceTimersByTimeAsync(10);
	expect(await running).toBe(answer);
	expect(calls).toBe(2);
	expect(vi.getTimerCount()).toBe(0);
});
