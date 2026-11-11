import { expect, test } from "vitest";
import { opencodeProvider } from "../src/providers/opencode.ts";
import { opencodeGoProvider } from "../src/providers/opencode-go.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const context = normalizeContext({ messages: [{ role: "user", content: "Ready?", timestamp: 1 }] });
const model: Model<"openai-completions"> = {
	id: "routing-test",
	name: "Routing test",
	provider: "opencode",
	api: "openai-completions",
	baseUrl: "https://provider.invalid/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

function response() {
	return new Response(
		'data: {"id":"reply","choices":[{"index":0,"delta":{"content":"Ready."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
		{ headers: { "content-type": "text/event-stream" } },
	);
}

for (const factory of [opencodeProvider, opencodeGoProvider])
	for (const operation of ["stream", "streamSimple"] as const)
		test(`${factory.name} ${operation} routes sessions without overwriting caller headers`, async () => {
			const provider = factory();
			for (const [sessionId, headers, expected] of [
				[undefined, { "x-project": "test" }, null],
				["", {}, null],
				["conversation", { "x-project": "test" }, "conversation"],
				["conversation", { "X-OpenCode-Session": "explicit" }, "explicit"],
			] satisfies [string | undefined, Record<string, string>, string | null][]) {
				const original = { ...headers };
				let sent = new Headers();
				const result = await provider[operation]({ ...model, provider: provider.id }, context, {
					apiKey: "synthetic-key",
					sessionId,
					headers,
					fetch: async (_input, init) => {
						sent = new Headers(init?.headers);
						return response();
					},
				}).result();
				expect(result).toMatchObject({ stopReason: "stop", content: [{ type: "text", text: "Ready." }] });
				expect(sent.get("x-opencode-session")).toBe(expected);
				if (headers["x-project"]) expect(sent.get("x-project")).toBe("test");
				expect(headers).toEqual(original);
			}
		});
