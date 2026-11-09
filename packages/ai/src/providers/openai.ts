import { openAIDecisionsApi } from "../api/openai-decisions.lazy.ts";
import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { OPENAI_MODELS, OPENAI_CLASSIFIER_MODELS } from "./openai.models.ts";
export function openaiProvider(): Provider<"openai-responses"> {
	return createProvider<"openai-responses">({
		id: "openai",
		name: "OpenAI",
		baseUrl: "https://api.openai.com/v1",
		models: [...Object.values(OPENAI_MODELS), ...Object.values(OPENAI_CLASSIFIER_MODELS)],
		api: openAIResponsesApi(),
		classifiers: { "openai-decisions": openAIDecisionsApi() },
		auth: { apiKey: envApiKeyAuth("OpenAI API key", ["OPENAI_API_KEY"]) },
	});
}
