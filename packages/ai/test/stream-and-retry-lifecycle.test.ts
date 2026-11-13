import { afterEach, expect, test, vi } from "vitest";
import { fauxAssistantMessage } from "../src/index.ts";
import { EventStream } from "../src/utils/event-stream.ts";
import { getOverflowPatterns, isContextOverflow, isRecoverableLength } from "../src/utils/overflow.ts";
import { retryAssistantCall, retryDelayMs } from "../src/utils/retry.ts";

afterEach(() => vi.useRealTimers());

test("ending an event stream releases every waiting reader and ignores later events", async () => {
	const stream = new EventStream<number, string>(() => false, String);
	const first = stream[Symbol.asyncIterator](),
		second = stream[Symbol.asyncIterator]();
	const waiting = [first.next(), second.next()];
	stream.end("closed");
	expect(await Promise.all(waiting)).toEqual([
		{ value: undefined, done: true },
		{ value: undefined, done: true },
	]);
	expect(await stream.result()).toBe("closed");
	stream.push(42);
	expect(await stream[Symbol.asyncIterator]().next()).toEqual({ value: undefined, done: true });
});

test.each(["stop", "aborted", "error"] as const)(
	"a retry that settles as %s reports one terminal callback",
	async (stopReason) => {
		vi.useFakeTimers();
		const initial = fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 service unavailable" });
		const final = fauxAssistantMessage([], {
			stopReason,
			...(stopReason === "error" ? { errorMessage: "payment required" } : {}),
		});
		const produce = vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(final);
		const scheduled = vi.fn(),
			started = vi.fn(),
			finished = vi.fn();
		const running = retryAssistantCall(produce, { enabled: true, maxRetries: 3, baseDelayMs: 25 }, undefined, {
			onRetryScheduled: scheduled,
			onRetryAttemptStart: started,
			onRetryFinished: finished,
		});
		await vi.advanceTimersByTimeAsync(25);
		expect(await running).toBe(final);
		expect(produce).toHaveBeenCalledTimes(2);
		expect(scheduled).toHaveBeenCalledExactlyOnceWith(1, 3, 25, "503 service unavailable");
		expect(started).toHaveBeenCalledOnce();
		expect(finished.mock.calls).toEqual([
			stopReason === "stop" ? [true, 1] : stopReason === "aborted" ? [false, 1] : [false, 1, "payment required"],
		]);
		expect(vi.getTimerCount()).toBe(0);
	},
);

test.each(["before", "during"] as const)(
	"cancellation %s backoff prevents another provider invocation",
	async (timing) => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const initial = fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 service unavailable" });
		const produce = vi.fn(async () => initial),
			finished = vi.fn();
		const running = retryAssistantCall(produce, { enabled: true, maxRetries: 3, baseDelayMs: 100 }, controller.signal, {
			onRetryScheduled() {
				if (timing === "before") controller.abort();
			},
			onRetryFinished: finished,
		});
		await vi.advanceTimersByTimeAsync(10);
		if (timing === "during") controller.abort();
		const result = await running;
		expect(result.stopReason).toBe("aborted");
		expect(result).not.toHaveProperty("errorMessage");
		expect(produce).toHaveBeenCalledTimes(1);
		expect(finished.mock.calls).toEqual([[false, 1, "503 service unavailable"]]);
		expect(vi.getTimerCount()).toBe(0);
	},
);

test("an overflowing exponential delay remains bounded by the configured maximum", () => {
	expect(retryDelayMs({ baseDelayMs: Number.MAX_VALUE, maxAgentDelayMs: 81 }, 100)).toBe(81);
});

test("output exhaustion is recoverable only when the requested output ceiling can still increase", () => {
	const message = fauxAssistantMessage([], { stopReason: "length" });
	message.usage.output = 12;
	expect(isRecoverableLength(message, 13)).toBe(true);
	expect(isRecoverableLength(message, 12)).toBe(false);
	expect(isRecoverableLength(message, 0)).toBe(false);
	message.stopReason = "stop";
	expect(isRecoverableLength(message, 13)).toBe(false);
});

test("overflow pattern snapshots are detached and transient provider errors do not trigger compaction", () => {
	const patterns = getOverflowPatterns();
	patterns.length = 0;
	expect(getOverflowPatterns().length).toBeGreaterThan(0);
	const message = fauxAssistantMessage([], {
		stopReason: "error",
		errorMessage: "413 (no body)",
	});
	message.provider = "cerebras";
	expect(isContextOverflow(message)).toBe(true);
	message.errorMessage = "Throttling error: too many tokens";
	expect(isContextOverflow(message)).toBe(false);
});
