import { expect, it } from "vitest";
import { lazyStream } from "../src/api/lazy.ts";
import { fauxAssistantMessage } from "../src/providers/faux.ts";
import type { Model } from "../src/types.ts";

it("forwards the final result of a proxy-backed source without relying on its has trap", async () => {
	const model: Model<"faux"> = {
		id: "fixture",
		name: "Fixture",
		provider: "faux",
		api: "faux",
		baseUrl: "",
		reasoning: false,
		input: ["text"],
		contextWindow: 100,
		maxTokens: 10,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	const response = fauxAssistantMessage([]);
	const source = new Proxy(
		{
			async *[Symbol.asyncIterator]() {},
			async result() {
				return response;
			},
		},
		{ has: () => false },
	);
	expect(await lazyStream(model, async () => source).result()).toBe(response);
});
