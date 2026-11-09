import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { googleGenerativeAIApi } from "../api/google-generative-ai.lazy.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { typesafeSystemOneApi } from "../api/typesafe-system-one.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { OPENCODE_MODELS, OPENCODE_CLASSIFIER_MODELS } from "./opencode.models.ts";
import { withOpenCodeSessionHeader as routed } from "./opencode-headers.ts";
type OpenCodeApi = "anthropic-messages" | "google-generative-ai" | "openai-completions" | "openai-responses";
export function opencodeProvider(): Provider<OpenCodeApi> {
	return createProvider<OpenCodeApi>({
		id: "opencode",
		name: "OpenCode Zen",
		models: [...Object.values(OPENCODE_MODELS), ...Object.values(OPENCODE_CLASSIFIER_MODELS)],
		auth: { apiKey: envApiKeyAuth("OpenCode API key", ["OPENCODE_API_KEY"]) },
		api: {
			"anthropic-messages": routed(anthropicMessagesApi()),
			"google-generative-ai": routed(googleGenerativeAIApi()),
			"openai-completions": routed(openAICompletionsApi()),
			"openai-responses": routed(openAIResponsesApi()),
		},
		classifiers: { "typesafe-system-one": typesafeSystemOneApi() },
	});
}
