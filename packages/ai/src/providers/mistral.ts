import { mistralConversationsApi } from "../api/mistral-conversations.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { MISTRAL_MODELS } from "./mistral.models.ts";

export function mistralProvider(): Provider<"mistral-conversations"> {
	const auth = envApiKeyAuth("Mistral API key", ["MISTRAL_API_KEY"]);
	return createProvider({
		id: "mistral",
		name: "Mistral",
		baseUrl: "https://api.mistral.ai",
		models: Object.values(MISTRAL_MODELS),
		api: mistralConversationsApi(),
		auth: { apiKey: auth },
	});
}
