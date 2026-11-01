import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { TOGETHER_MODELS } from "./together.models.ts";

export function togetherProvider(): Provider<"openai-completions"> {
	const auth = envApiKeyAuth("Together API key", ["TOGETHER_API_KEY"]);
	return createProvider({
		id: "together",
		name: "Together",
		baseUrl: "https://api.together.ai/v1",
		models: Object.values(TOGETHER_MODELS),
		api: openAICompletionsApi(),
		auth: { apiKey: auth },
	});
}
