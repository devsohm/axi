import { afterEach, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxProvider } from "../src/providers/faux.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

afterEach(() => vi.useRealTimers());

it("keeps the configured streaming rate after its options object changes", async () => {
	vi.useFakeTimers();
	vi.setSystemTime(0);
	const options = { tokensPerSecond: 1, tokenSize: { min: 1, max: 1 } };
	const handle = fauxProvider(options);
	options.tokensPerSecond = 2;
	handle.setResponses([fauxAssistantMessage("abcd")]);
	let completedAt: number | undefined;
	const result = handle.provider.streamSimple(handle.getModel(), normalizeContext({ messages: [] }), {}).result();
	void result.then(() => {
		completedAt = Date.now();
	});
	await vi.advanceTimersByTimeAsync(1000);
	expect((await result).content).toEqual([{ type: "text", text: "abcd" }]);
	expect(completedAt).toBe(1000);
});

it("accounts for cached prompt prefixes across edits and shorter histories", async () => {
	const handle = fauxProvider(),
		usage = [];
	for (const values of [["a", "b"], ["a", "bc"], ["a"]]) {
		handle.setResponses([fauxAssistantMessage([])]);
		const result = await handle.provider
			.streamSimple(
				handle.getModel(),
				normalizeContext({
					messages: values.map((content) => ({ role: "user", content, timestamp: 0 })),
				}),
				{ sessionId: "cache" },
			)
			.result();
		usage.push(result.usage);
	}
	expect(
		usage.map(({ input, cacheRead, cacheWrite, totalTokens }) => ({ input, cacheRead, cacheWrite, totalTokens })),
	).toEqual([
		{ input: 4, cacheRead: 0, cacheWrite: 4, totalTokens: 8 },
		{ input: 0, cacheRead: 4, cacheWrite: 1, totalTokens: 5 },
		{ input: 0, cacheRead: 2, cacheWrite: 0, totalTokens: 2 },
	]);
});
