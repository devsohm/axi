import { afterEach, expect, it, vi } from "vitest";
import { streamSimple as google } from "../src/api/google-generative-ai.ts";
import { streamSimple as vertex } from "../src/api/google-vertex.ts";
import type { FetchFunction, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const transcript = normalizeContext({ messages: [{ role: "user", content: "Count to three", timestamp: 0 }] });
const model: Model<"google-generative-ai"> = {
	id: "gemini-test",
	name: "Test",
	api: "google-generative-ai",
	provider: "test",
	baseUrl: "https://google.invalid/v1",
	reasoning: false,
	input: ["text"],
	contextWindow: 4096,
	maxTokens: 100,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const providers = [
	{
		name: "Google",
		request: (fetch?: FetchFunction) => google(model, transcript, { apiKey: "fixture", fetch, maxRetries: 0 }),
	},
	{
		name: "Vertex",
		request: (fetch?: FetchFunction) =>
			vertex({ ...model, api: "google-vertex" }, transcript, { apiKey: "fixture", fetch, maxRetries: 0 }),
	},
];

afterEach(() => vi.unstubAllGlobals());

for (const provider of providers) {
	it.each(["custom", "global"] as const)(
		`${provider.name} uses %s fetch without an SDK dispatcher override`,
		async (source) => {
			const transport = vi.fn<FetchFunction>(
				async () => new Response(JSON.stringify({ error: { message: "fixture refusal" } }), { status: 400 }),
			);
			const ambient =
				source === "global"
					? transport
					: vi.fn<FetchFunction>(async () => {
							throw new Error("Unexpected global fetch");
						});
			vi.stubGlobal("fetch", ambient);
			const result = await provider.request(source === "custom" ? transport : undefined).result();
			expect(transport).toHaveBeenCalledOnce();
			const [url, init] = transport.mock.calls[0]!;
			expect(url instanceof Request ? url.url : String(url)).toContain("https://google.invalid/v1");
			expect(init).not.toHaveProperty("dispatcher");
			expect(result).toMatchObject({ stopReason: "error", errorMessage: expect.stringContaining("fixture refusal") });
			if (source === "custom") expect(ambient).not.toHaveBeenCalled();
			expect(globalThis.fetch).toBe(ambient);
		},
	);

	it(`${provider.name} returns partial text once when the SDK supplies a continuation token`, async () => {
		const transport = vi.fn<FetchFunction>(async () => {
			if (transport.mock.calls.length > 1) throw new Error("Unexpected automatic continuation");
			return new Response(
				`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "One, two" }] }, finishReason: "CONTINUATION", continuationToken: "next-part" }] })}\n\n`,
				{ headers: { "content-type": "text/event-stream" } },
			);
		});
		const result = await provider.request(transport).result();
		expect(transport).toHaveBeenCalledOnce();
		expect(result).toMatchObject({
			stopReason: "length",
			rawStopReason: "CONTINUATION",
			content: [{ type: "text", text: "One, two" }],
		});
		expect(result.errorMessage).toBeUndefined();
	});
}
