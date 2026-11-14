import { expect, test, vi } from "vitest";
import { Type } from "typebox";
import { stream as google } from "../src/api/google-generative-ai.ts";
import { stream as vertex } from "../src/api/google-vertex.ts";
import type { GoogleOptions } from "../src/api/options.ts";
import type { FetchFunction, Model, Tool } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"google-generative-ai"> = {
	api: "google-generative-ai",
	id: "gemini-3-pro",
	provider: "google",
	name: "Tool routing",
	baseUrl: "https://google.invalid/v1",
	reasoning: false,
	input: ["text"],
	contextWindow: 4096,
	maxTokens: 100,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const tool: Tool = { name: "inspect", description: "Inspect a number", parameters: Type.Object({ n: Type.Number() }) };
const cases: {
	name: string;
	choice?: GoogleOptions["toolChoice"];
	strict?: "require" | "prefer";
	id?: string;
	mode?: string;
	tools?: false;
}[] = [
	{ name: "no active tools", tools: false, choice: "any" },
	{ name: "unspecified ordinary tool" },
	{ name: "automatic ordinary tool", choice: "auto", mode: "AUTO" },
	{ name: "disabled calls", choice: "none", mode: "NONE" },
	{ name: "required call", choice: "any", mode: "ANY" },
	{ name: "preferred strict schema", strict: "prefer", mode: "VALIDATED" },
	{ name: "strict automatic calls", strict: "require", choice: "auto", mode: "VALIDATED" },
	{ name: "strict disabled calls", strict: "require", choice: "none", mode: "NONE" },
	{ name: "strict required call", strict: "require", choice: "any", mode: "ANY" },
	{ name: "older model with preferred strict schema", id: "gemini-2.5-pro", strict: "prefer" },
];

for (const api of ["google-generative-ai", "google-vertex"] as const) {
	test.each(cases)(`${api} forwards $name to its actual SDK transport`, async ({ tools, strict, choice, id, mode }) => {
		const transcript = normalizeContext({
			tools:
				tools === false
					? []
					: [{ ...tool, ...(strict ? { constrainedSampling: { type: "json_schema" as const, strict } } : {}) }],
			messages: [{ role: "user", content: "Inspect 1", timestamp: 0 }],
		});
		let body: unknown;
		const fetch = vi.fn<FetchFunction>(async (_url, init) => {
			body = JSON.parse(String(init?.body));
			return new Response(
				`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "Done" }] }, finishReason: "STOP" }] })}\n\n`,
				{ headers: { "content-type": "text/event-stream" } },
			);
		});
		const options: GoogleOptions = { apiKey: "fixture", fetch, maxRetries: 0, toolChoice: choice };
		const result = await (api === "google-generative-ai"
			? google({ ...model, id: id ?? model.id }, transcript, options)
			: vertex({ ...model, id: id ?? model.id, api: "google-vertex", provider: "vertex" }, transcript, options)
		).result();
		expect(result).toMatchObject({ stopReason: "stop", content: [{ type: "text", text: "Done" }] });
		expect(fetch).toHaveBeenCalledOnce();
		if (mode === undefined) expect(body).not.toHaveProperty("toolConfig");
		else expect(body).toMatchObject({ toolConfig: { functionCallingConfig: { mode } } });
		if (tools === false) expect(body).not.toHaveProperty("tools");
		else expect(body).toHaveProperty("tools.0.functionDeclarations.0.name", "inspect");
		expect(tool.parameters).not.toHaveProperty("additionalProperties");
	});

	test(`${api} refuses required strict schemas on an older model before sending a request`, async () => {
		const transcript = normalizeContext({
			tools: [{ ...tool, constrainedSampling: { type: "json_schema", strict: "require" } }],
			messages: [],
		});
		const fetch = vi.fn<FetchFunction>();
		const options = { apiKey: "fixture", fetch, maxRetries: 0 };
		const result = await (api === "google-generative-ai"
			? google({ ...model, id: "gemini-2.5-pro" }, transcript, options)
			: vertex({ ...model, id: "gemini-2.5-pro", api: "google-vertex", provider: "vertex" }, transcript, options)
		).result();
		expect(result).toMatchObject({ stopReason: "error", content: [], errorMessage: expect.stringContaining("strict") });
		expect(fetch).not.toHaveBeenCalled();
	});

	test(`${api} assigns distinct IDs to streamed calls that arrive without wire IDs`, async () => {
		const transcript = normalizeContext({
			tools: [tool],
			messages: [{ role: "user", content: "Inspect 1 and 2", timestamp: 0 }],
		});
		const fetch: FetchFunction = async () =>
			new Response(
				`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [1, 2].map((n) => ({ functionCall: { name: "inspect", args: { n } } })) }, finishReason: "STOP" }] })}\n\n`,
				{ headers: { "content-type": "text/event-stream" } },
			);
		const options = { apiKey: "fixture", fetch, maxRetries: 0 };
		const result = await (api === "google-generative-ai"
			? google(model, transcript, options)
			: vertex({ ...model, api: "google-vertex", provider: "vertex" }, transcript, options)
		).result();
		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toMatchObject(
			[1, 2].map((n) => ({
				type: "toolCall",
				name: "inspect",
				arguments: { n },
				id: expect.stringMatching(/^inspect_/),
			})),
		);
		const ids = result.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : []));
		expect(new Set(ids).size).toBe(2);
	});
}
