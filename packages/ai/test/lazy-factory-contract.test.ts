import { afterEach, expect, test, vi } from "vitest";
import {
	buildCopilotDynamicHeaders,
	hasCopilotVisionInput,
	inferCopilotInitiator,
} from "../src/api/github-copilot-headers.ts";
import { llamaCppClassifyApi } from "../src/api/llama-cpp-classify.lazy.ts";
import { registerLazyOAuthFlows } from "../src/lazy-oauth.ts";
import {
	loadAnthropicOAuth,
	loadGitHubCopilotOAuth,
	loadKimiCodingOAuth,
	loadMetaOAuth,
	loadOpenAICodexOAuth,
	loadOpenRouterOAuth,
	loadXaiOAuth,
} from "../src/auth/oauth/load.ts";
import { fauxAssistantMessage } from "../src/providers/faux.ts";
import type { ClassifierModel, Message } from "../src/types.ts";

afterEach(() => vi.unstubAllGlobals());

test("bundled lazy OAuth flows derive model credentials without opening a browser or making a request", async () => {
	const fetch = vi.fn(() => {
		throw new Error("Auth derivation must stay offline");
	});
	vi.stubGlobal("fetch", fetch);
	registerLazyOAuthFlows();
	const credential = { type: "oauth", access: "access", refresh: "refresh", expires: Date.now() + 3600000 } as const;
	for (const load of [loadAnthropicOAuth, loadOpenAICodexOAuth, loadOpenRouterOAuth, loadMetaOAuth, loadXaiOAuth])
		expect(await (await load()).toAuth(credential)).toEqual({ apiKey: "access" });
	expect(await (await loadGitHubCopilotOAuth()).toAuth(credential)).toEqual({
		apiKey: "access",
		baseUrl: "https://api.individual.githubcopilot.com",
	});
	expect(await (await loadKimiCodingOAuth()).toAuth(credential)).toEqual({
		headers: { Authorization: "Bearer access" },
	});
	expect(fetch).not.toHaveBeenCalled();
});

test("Copilot request headers identify tool-driven turns and vision content without treating assistant output as input", () => {
	const image = { type: "image", data: "AQID", mimeType: "image/png" } as const;
	const user: Message = { role: "user", content: [image], timestamp: 1 };
	const tool: Message = {
		role: "toolResult",
		content: [image],
		toolCallId: "call",
		toolName: "read",
		isError: false,
		timestamp: 2,
	};
	expect(inferCopilotInitiator([])).toBe("user");
	expect(inferCopilotInitiator([user])).toBe("user");
	expect(inferCopilotInitiator([user, fauxAssistantMessage("answer")])).toBe("agent");
	expect(inferCopilotInitiator([tool])).toBe("agent");
	expect(hasCopilotVisionInput([user])).toBe(true);
	expect(hasCopilotVisionInput([tool])).toBe(true);
	expect(
		hasCopilotVisionInput([{ role: "user", content: "plain", timestamp: 1 }, fauxAssistantMessage("answer")]),
	).toBe(false);
	expect(buildCopilotDynamicHeaders({ messages: [tool], hasImages: true })).toEqual({
		"X-Initiator": "agent",
		"Openai-Intent": "conversation-edits",
		"Copilot-Vision-Request": "true",
	});
	expect(buildCopilotDynamicHeaders({ messages: [user], hasImages: false })).toEqual({
		"X-Initiator": "user",
		"Openai-Intent": "conversation-edits",
	});
});

test("the lazy local classifier loads its implementation and reports validation failures before a request", async () => {
	const fetch = vi.fn(() => {
		throw new Error("Invalid classifier input must stay offline");
	});
	const model: ClassifierModel<"llama-cpp-classify"> = {
		type: "classifier",
		api: "llama-cpp-classify",
		id: "local",
		name: "Local",
		provider: "local",
		baseUrl: "http://127.0.0.1:8080/v1",
		input: ["text"],
		contextWindow: 1000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	const api = llamaCppClassifyApi();
	const result = await api.classify(model, { state: {}, questions: {} }, { temperature: 0, fetch });
	expect(result).toMatchObject({
		stopReason: "error",
		errorMessage: expect.stringContaining("Temperature must be a positive number"),
	});
	expect(fetch).not.toHaveBeenCalled();
});
