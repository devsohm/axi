import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { QWEN_TOKEN_PLAN_MODELS } from "./qwen-token-plan.models.ts";

export function qwenTokenPlanProvider(): Provider<"openai-completions"> {
	const auth = envApiKeyAuth("Qwen Token Plan Team API key", [
		"QWEN_TOKEN_PLAN_TEAM_API_KEY",
		"QWEN_TOKEN_PLAN_API_KEY",
	]);
	return createProvider({
		id: "qwen-token-plan",
		name: "Qwen Token Plan Team",
		baseUrl: "https://token-plan.maas.qwencloudapi.com/compatible-mode/v1",
		models: Object.values(QWEN_TOKEN_PLAN_MODELS),
		api: openAICompletionsApi(),
		auth: { apiKey: auth },
	});
}
