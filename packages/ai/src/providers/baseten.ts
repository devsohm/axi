import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { BASETEN_MODELS } from "./baseten.models.ts";

export function basetenProvider(): Provider<"openai-completions"> {
	const auth = envApiKeyAuth("Baseten API key", ["BASETEN_API_KEY"]);
	return createProvider({
		id: "baseten",
		name: "Baseten",
		baseUrl: "https://inference.baseten.co/v1",
		models: Object.values(BASETEN_MODELS),
		api: openAICompletionsApi(),
		auth: { apiKey: auth },
	});
}
