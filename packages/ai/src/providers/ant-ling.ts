import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { ANT_LING_MODELS } from "./ant-ling.models.ts";

export function antLingProvider(): Provider<"openai-completions"> {
	const auth = envApiKeyAuth("Ant Ling API key", ["ANT_LING_API_KEY"]);
	return createProvider({
		id: "ant-ling",
		name: "Ant Ling",
		baseUrl: "https://api.ant-ling.com/v1",
		models: Object.values(ANT_LING_MODELS),
		api: openAICompletionsApi(),
		auth: { apiKey: auth },
	});
}
