import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { DEEPSEEK_MODELS } from "./deepseek.models.ts";

export function deepseekProvider(): Provider<"openai-completions"> {
	const auth = envApiKeyAuth("DeepSeek API key", ["DEEPSEEK_API_KEY"]);
	return createProvider({
		id: "deepseek",
		name: "DeepSeek",
		baseUrl: "https://api.deepseek.com",
		models: Object.values(DEEPSEEK_MODELS),
		api: openAICompletionsApi(),
		auth: { apiKey: auth },
	});
}
