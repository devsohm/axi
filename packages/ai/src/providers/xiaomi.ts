import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { XIAOMI_MODELS } from "./xiaomi.models.ts";

export function xiaomiProvider(): Provider<"openai-completions"> {
	const auth = envApiKeyAuth("Xiaomi API key", ["XIAOMI_API_KEY"]);
	return createProvider({
		id: "xiaomi",
		name: "Xiaomi",
		baseUrl: "https://api.xiaomimimo.com/v1",
		models: Object.values(XIAOMI_MODELS),
		api: openAICompletionsApi(),
		auth: { apiKey: auth },
	});
}
