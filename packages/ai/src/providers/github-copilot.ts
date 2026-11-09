import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { typesafeSystemOneApi } from "../api/typesafe-system-one.lazy.ts";
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
import { loadGitHubCopilotOAuth } from "../auth/oauth/load.ts";
import { createProvider, type Provider } from "../models.ts";
import { GITHUB_COPILOT_CLASSIFIER_MODELS, GITHUB_COPILOT_MODELS } from "./github-copilot.models.ts";

export function githubCopilotProvider(): Provider<"anthropic-messages" | "openai-completions" | "openai-responses"> {
	return createProvider<"anthropic-messages" | "openai-completions" | "openai-responses">({
		id: "github-copilot",
		name: "GitHub Copilot",
		baseUrl: "https://api.individual.githubcopilot.com",
		auth: {
			apiKey: envApiKeyAuth("GitHub Copilot token", ["COPILOT_GITHUB_TOKEN"]),
			oauth: lazyOAuth({
				name: "GitHub Copilot",
				isSubscription: true,
				load: loadGitHubCopilotOAuth,
			}),
		},
		models: [...Object.values(GITHUB_COPILOT_MODELS), ...Object.values(GITHUB_COPILOT_CLASSIFIER_MODELS)],
		filterModels(models, credential) {
			const ids = credential?.type === "oauth" ? credential.availableModelIds : undefined;
			if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) return models;
			const available = new Set(ids);
			return models.filter((model) => available.has(model.id));
		},
		api: {
			"anthropic-messages": anthropicMessagesApi(),
			"openai-completions": openAICompletionsApi(),
			"openai-responses": openAIResponsesApi(),
		},
		classifiers: {
			"typesafe-system-one": {
				classify(model, context, options) {
					return typesafeSystemOneApi().classify(
						{ ...model, baseUrl: model.baseUrl.replace(/\/+$/, "") + "/v1" },
						context,
						options,
					);
				},
			},
		},
	});
}
