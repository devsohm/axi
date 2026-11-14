import { expect, test, vi } from "vitest";
import { anthropicMessagesApi } from "../src/api/anthropic-messages.lazy.ts";
import { azureOpenAIResponsesApi } from "../src/api/azure-openai-responses.lazy.ts";
import {
	bedrockConverseStreamApi,
	setBedrockProviderLoader,
	setBedrockProviderModule,
} from "../src/api/bedrock-converse-stream.lazy.ts";
import { googleVertexApi } from "../src/api/google-vertex.lazy.ts";
import { lazyApi } from "../src/api/lazy.ts";
import { mistralConversationsApi } from "../src/api/mistral-conversations.lazy.ts";
import { openAICodexResponsesApi } from "../src/api/openai-codex-responses.lazy.ts";
import { openAIDecisionsApi } from "../src/api/openai-decisions.lazy.ts";
import { bedrockProviderModule } from "../src/bedrock-provider.ts";
import type { Api, Model, ProviderStreams } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<Api> = {
	api: "anthropic-messages",
	id: "test",
	provider: "offline",
	name: "Offline",
	baseUrl: "https://offline.invalid/v1",
	reasoning: false,
	input: ["text"],
	contextWindow: 1000,
	maxTokens: 100,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const context = normalizeContext({ messages: [{ role: "user", content: "Hello", timestamp: 0 }] });
const token = `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "offline-account" } })).toString("base64url")}.fixture`;
const variants: { api: Api; load(): ProviderStreams }[] = [
	{ api: "anthropic-messages", load: anthropicMessagesApi },
	{ api: "azure-openai-responses", load: azureOpenAIResponsesApi },
	{ api: "google-vertex", load: googleVertexApi },
	{ api: "mistral-conversations", load: mistralConversationsApi },
	{ api: "openai-codex-responses", load: openAICodexResponsesApi },
];

for (const method of ["stream", "streamSimple"] as const)
	test.each(variants)(`$api ${method} loads its actual provider encoder`, async ({ api, load }) => {
		const payloads: unknown[] = [],
			fetch = vi.fn(async () => {
				throw new Error("Unexpected request");
			});
		const result = await load()
			[method]({ ...model, api }, context, {
				apiKey: api === "openai-codex-responses" ? token : "offline-key",
				fetch,
				maxRetries: 0,
				onPayload(payload) {
					payloads.push(payload);
					throw new Error("Stopped before dispatch");
				},
			})
			.result();
		expect(result).toMatchObject({
			stopReason: "error",
			errorMessage: expect.stringContaining("Stopped before dispatch"),
		});
		expect(payloads).toHaveLength(1);
		expect(fetch).not.toHaveBeenCalled();
	});

test("Bedrock supports its native default, an installed provider module and a replaceable loader", async () => {
	let loads = 0;
	for (const source of ["default", "module", "loader"] as const) {
		if (source === "module") setBedrockProviderModule(bedrockProviderModule);
		if (source === "loader")
			setBedrockProviderLoader(async () => {
				loads++;
				return bedrockProviderModule;
			});
		const payloads: unknown[] = [];
		for (const method of ["stream", "streamSimple"] as const) {
			const result = await bedrockConverseStreamApi()
				[method]({ ...model, api: "bedrock-converse-stream" }, context, {
					apiKey: "offline-key",
					env: { AWS_REGION: "us-east-1", AWS_BEDROCK_SKIP_AUTH: "1" },
					onPayload(payload) {
						payloads.push(payload);
						throw new Error("Stopped before dispatch");
					},
				})
				.result();
			expect(result).toMatchObject({
				stopReason: "error",
				errorMessage: expect.stringContaining("Stopped before dispatch"),
			});
		}
		expect(payloads).toHaveLength(2);
	}
	expect(loads).toBe(2);
});

test("the lazy Decisions classifier validates and encodes a request before dispatch", async () => {
	let payload: unknown;
	const fetch = vi.fn(async () => {
		throw new Error("Unexpected request");
	});
	const result = await openAIDecisionsApi().classify(
		{
			type: "classifier",
			api: "openai-decisions",
			provider: model.provider,
			id: model.id,
			name: model.name,
			baseUrl: model.baseUrl,
			input: model.input,
			contextWindow: model.contextWindow,
			cost: model.cost,
		},
		{
			state: { ready: true },
			questions: { ready: { type: "bool", instructions: "Ready?", criteria: { true: "Ready", false: "Waiting" } } },
		},
		{
			apiKey: "offline-key",
			fetch,
			onPayload(value) {
				payload = value;
				throw new Error("Stopped before dispatch");
			},
		},
	);
	expect(result).toMatchObject({
		stopReason: "error",
		errorMessage: expect.stringContaining("Stopped before dispatch"),
	});
	expect(payload).toMatchObject({ model: "test", questions: [{ name: "ready" }] });
	expect(fetch).not.toHaveBeenCalled();
});

test("lazy deferred cancellation forwards the saved handle through the loaded provider", async () => {
	const calls: unknown[] = [],
		controller = new AbortController();
	const implementation: ProviderStreams = {
		stream() {
			throw new Error("Unexpected stream");
		},
		streamSimple() {
			throw new Error("Unexpected stream");
		},
		async cancelDeferred(selected, handle, options) {
			calls.push({ selected, handle, signal: options?.signal });
		},
	};
	const api = lazyApi(async () => implementation, { cancelDeferred: true });
	if (!api.cancelDeferred) throw new Error("Cancellation was not advertised");
	const handle = { api: "openai-responses", provider: "offline", modelId: "test", id: "saved-response" };
	await api.cancelDeferred(model, handle, { signal: controller.signal });
	expect(calls).toEqual([{ selected: model, handle, signal: controller.signal }]);
});
