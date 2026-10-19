import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { CEREBRAS_MODELS } from "./cerebras.models.ts";

export function cerebrasProvider(): Provider<"openai-completions"> {
	const auth = envApiKeyAuth("Cerebras API key", ["CEREBRAS_API_KEY"]);
	return createProvider({
		id: "cerebras",
		name: "Cerebras",
		baseUrl: "https://api.cerebras.ai/v1",
		models: Object.values(CEREBRAS_MODELS),
		api: openAICompletionsApi(),
		auth: { apiKey: auth },
	});
}
