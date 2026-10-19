import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { googleGenerativeAIApi } from "../api/google-generative-ai.lazy.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { OPENCODE_GO_MODELS } from "./opencode-go.models.ts";
import { withOpenCodeSessionHeader as routed } from "./opencode-headers.ts";
type OpenCodeGoApi = "anthropic-messages" | "google-generative-ai" | "openai-completions" | "openai-responses";
export function opencodeGoProvider(): Provider<OpenCodeGoApi> {
	return createProvider<OpenCodeGoApi>({
		id: "opencode-go",
		name: "OpenCode Go",
		models: Object.values(OPENCODE_GO_MODELS),
		auth: { apiKey: envApiKeyAuth("OpenCode API key", ["OPENCODE_API_KEY"]) },
		api: {
			"anthropic-messages": routed(anthropicMessagesApi()),
			"google-generative-ai": routed(googleGenerativeAIApi()),
			"openai-completions": routed(openAICompletionsApi()),
			"openai-responses": routed(openAIResponsesApi()),
		},
	});
}
