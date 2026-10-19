import { expect, it } from "vitest";
import { buildBaseOptions } from "../src/api/simple-options.ts";
import { streamSimple as responses } from "../src/api/openai-responses.ts";
import { streamSimple as azure } from "../src/api/azure-openai-responses.ts";
import { streamSimple as completions } from "../src/api/openai-completions.ts";
import { streamSimple as codex } from "../src/api/openai-codex-responses.ts";
import { streamSimple as mistral } from "../src/api/mistral-conversations.ts";
import type { Api, Model, SimpleStreamOptions, ThinkingLevel } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

function model<A extends Api>(api: A): Model<A> {
	return {
		id: "fixture",
		name: "Fixture",
		api,
		provider: "fixture",
		baseUrl: "https://sampling-order.invalid/v1",
		reasoning: true,
		thinkingLevelMap: { low: "low", high: "high" },
		samplingParamsByThinkingLevel: { low: { audit_scalar: 1 }, high: { audit_scalar: 2 } },
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 10000,
		maxTokens: 100,
	};
}
const transcript = normalizeContext({ messages: [{ role: "user", content: "Hi", timestamp: 1 }] });
it.each([
	{
		api: "openai-responses",
		run: (options: SimpleStreamOptions) => responses(model("openai-responses"), transcript, options),
	},
	{
		api: "azure-openai-responses",
		run: (options: SimpleStreamOptions) => azure(model("azure-openai-responses"), transcript, options),
	},
	{
		api: "openai-completions",
		run: (options: SimpleStreamOptions) => completions(model("openai-completions"), transcript, options),
	},
	{
		api: "openai-codex-responses",
		run: (options: SimpleStreamOptions) => codex(model("openai-codex-responses"), transcript, options),
	},
	{
		api: "mistral-conversations",
		run: (options: SimpleStreamOptions) => mistral(model("mistral-conversations"), transcript, options),
	},
])("resolves $api base options before its API reasoning controls", async ({ run }) => {
	const reads: string[] = [];
	let reasoningReads = 0;
	const options: SimpleStreamOptions = {
		apiKey: `h.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } }))}.s`,
		transport: "sse",
		get reasoning(): ThinkingLevel {
			reads.push("reasoning");
			return ++reasoningReads === 1 ? "low" : "high";
		},
		get temperature() {
			reads.push("temperature");
			return 0.7;
		},
		onPayload() {
			throw new Error("Stop offline fixture");
		},
		fetch: async () => {
			throw new Error("Unexpected network request");
		},
	};
	const result = await run(options).result();
	expect(reads).toEqual(["reasoning", "temperature", "reasoning", "reasoning"]);
	expect(result.stopReason).toBe("error");
	expect(result.errorMessage).toContain("Stop offline fixture");
});

it("resolves sampling defaults before reading the temperature option", () => {
	const reads: string[] = [];
	const model: Model<"openai-responses"> = {
		id: "fixture",
		name: "Fixture",
		api: "openai-responses",
		provider: "fixture",
		baseUrl: "https://fixture.invalid",
		get reasoning() {
			reads.push("model.reasoning");
			return false;
		},
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 20000,
		maxTokens: 100,
		samplingParams: { temperature: 0.2 },
	};
	const options = {
		get reasoning(): undefined {
			reads.push("reasoning");
			return undefined;
		},
		get samplingParams(): undefined {
			reads.push("samplingParams");
			return undefined;
		},
		get temperature(): number {
			reads.push("temperature");
			model.samplingParams = { temperature: 0.9 };
			return 0.7;
		},
	};
	const result = buildBaseOptions(model, normalizeContext({ messages: [] }), options);
	expect(reads).toEqual(["reasoning", "samplingParams", "model.reasoning", "temperature"]);
	expect(result.samplingParams).toEqual({ temperature: 0.2 });
	expect(result.temperature).toBe(0.7);
});
