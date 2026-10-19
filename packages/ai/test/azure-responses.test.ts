import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { resolveAzureConfig, resolveDeploymentName } from "../src/api/azure-openai-config.ts";
import { stream, streamSimple } from "../src/api/azure-openai-responses.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"azure-openai-responses"> = {
	id: "test-model",
	name: "Test",
	api: "azure-openai-responses",
	provider: "azure",
	baseUrl: "",
	reasoning: true,
	input: ["text"],
	contextWindow: 100_000,
	maxTokens: 4000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const context = normalizeContext({
	messages: [{ role: "user", content: "hello", timestamp: 1 }],
	tools: [{ name: "read", description: "Read", parameters: Type.Object({ path: Type.String() }) }],
});
function completed(): Response {
	return new Response('data: {"type":"response.completed","response":{"id":"azure-1","status":"completed"}}\n\n', {
		headers: { "content-type": "text/event-stream", "x-request-id": "request-1" },
	});
}
describe("Azure Responses", () => {
	it("resolves the base URL before reading the fallback resource", () => {
		const options = {
			azureResourceName: "initial",
			env: {},
			get azureBaseUrl() {
				options.azureResourceName = "selected";
				return "";
			},
		};
		expect(resolveAzureConfig(model, options)).toEqual({
			baseUrl: "https://selected.openai.azure.com/openai/v1",
			apiVersion: "v1",
		});
	});
	it("selects the deployment before the endpoint configuration", async () => {
		let url = "";
		const options = {
			apiKey: "test-key",
			azureResourceName: "initial",
			env: {},
			get azureDeploymentName() {
				options.azureResourceName = "selected";
				return "deployed";
			},
			fetch: async (input: string | URL | Request) => {
				url = String(input);
				return completed();
			},
		};
		const result = await stream(model, context, options).result();
		expect({ url, reason: result.stopReason }).toEqual({
			url: "https://selected.openai.azure.com/openai/v1/responses?api-version=v1",
			reason: "stop",
		});
	});
	it.each(["openai.azure.com", "cognitiveservices.azure.com", "ai.azure.com"])("normalizes %s endpoints", (domain) => {
		expect(resolveAzureConfig(model, { azureBaseUrl: `https://resource.${domain}/openai/?old=true`, env: {} })).toEqual(
			{ baseUrl: `https://resource.${domain}/openai/v1`, apiVersion: "v1" },
		);
	});
	it("preserves a proxy path and query while preferring explicit configuration", () => {
		expect(
			resolveAzureConfig(model, {
				azureBaseUrl: "https://proxy.invalid/custom?keep=true",
				azureApiVersion: "custom",
				env: { AZURE_OPENAI_BASE_URL: "https://ignored.invalid", AZURE_OPENAI_API_VERSION: "ignored" },
			}),
		).toEqual({ baseUrl: "https://proxy.invalid/custom?keep=true", apiVersion: "custom" });
	});
	it("resolves the last valid deployment mapping and explicit override", () => {
		const env = { AZURE_OPENAI_DEPLOYMENT_NAME_MAP: "broken, test-model=first, other=other, test-model=last" };
		expect(resolveDeploymentName(model, { env })).toBe("last");
		expect(resolveDeploymentName(model, { env, azureDeploymentName: "explicit" })).toBe("explicit");
	});
	it("uses the SDK deployment path, clamps tokens, and forwards tool choice", async () => {
		let url = "",
			body = "",
			apiKey: string | null = null;
		const result = await stream(model, context, {
			apiKey: "test-key",
			azureResourceName: "resource",
			azureDeploymentName: "deployed",
			maxTokens: 1,
			toolChoice: "required",
			reasoningEffort: "high",
			sessionId: "s".repeat(70),
			env: {},
			fetch: async (input, init) => {
				url = String(input);
				body = String(init?.body);
				apiKey = new Headers(init?.headers).get("api-key");
				return completed();
			},
		}).result();
		expect({ url, apiKey, stop: result.stopReason, responseId: result.responseId }).toEqual({
			url: "https://resource.openai.azure.com/openai/v1/responses?api-version=v1",
			apiKey: "test-key",
			stop: "stop",
			responseId: "azure-1",
		});
		expect(JSON.parse(body)).toMatchObject({
			model: "deployed",
			max_output_tokens: 16,
			prompt_cache_key: "s".repeat(64),
			store: false,
			tool_choice: "required",
			tools: [{ name: "read", strict: false }],
			reasoning: { effort: "high", summary: "auto" },
		});
	});
	it("returns a useful configuration error before attempting a request", async () => {
		const result = await stream(model, context, { apiKey: "test-key", azureBaseUrl: "not a URL", env: {} }).result();
		expect(result).toMatchObject({ stopReason: "error", errorMessage: "Invalid Azure OpenAI base URL: not a URL" });
	});
	it("supports simple options through the same SDK request path", async () => {
		let body = "";
		const result = await streamSimple({ ...model, baseUrl: "https://proxy.invalid/v1" }, context, {
			apiKey: "test-key",
			reasoning: "high",
			toolChoice: "none",
			env: {},
			fetch: async (_input, init) => {
				body = String(init?.body);
				return completed();
			},
		}).result();
		expect({ stop: result.stopReason, body: JSON.parse(body) }).toMatchObject({
			stop: "stop",
			body: { model: "test-model", tool_choice: "none", reasoning: { effort: "high" } },
		});
	});
});
