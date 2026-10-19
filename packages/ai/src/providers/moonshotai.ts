import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { MOONSHOTAI_MODELS } from "./moonshotai.models.ts";

export function moonshotaiProvider(): Provider<"openai-completions"> {
	const auth = envApiKeyAuth("Moonshot AI API key", ["MOONSHOT_API_KEY"]);
	return createProvider({
		id: "moonshotai",
		name: "Moonshot AI",
		baseUrl: "https://api.moonshot.ai/v1",
		models: Object.values(MOONSHOTAI_MODELS),
		api: openAICompletionsApi(),
		auth: { apiKey: auth },
	});
}
