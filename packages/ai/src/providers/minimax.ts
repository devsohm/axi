import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { MINIMAX_MODELS } from "./minimax.models.ts";

export function minimaxProvider(): Provider<"anthropic-messages"> {
	const auth = envApiKeyAuth("MiniMax API key", ["MINIMAX_API_KEY"]);
	return createProvider({
		id: "minimax",
		name: "MiniMax",
		baseUrl: "https://api.minimax.io/anthropic",
		models: Object.values(MINIMAX_MODELS),
		api: anthropicMessagesApi(),
		auth: { apiKey: auth },
	});
}
