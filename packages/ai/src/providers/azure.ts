import { resolveAzureBaseUrl, resolveDeploymentName } from "../api/azure-openai-config.ts";
import { azureOpenAIResponsesApi } from "../api/azure-openai-responses.lazy.ts";
import { lazyStream } from "../api/lazy.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import type { Api, Model, ProviderStreams, StreamOptions } from "../types.ts";
import { AZURE_MODELS } from "./azure.models.ts";

function deployment<O extends StreamOptions>(model: Model<Api>, options: O | undefined): O | undefined {
	const name = resolveDeploymentName(model, options);
	if (name === model.id) return options;
	return {
		...options,
		onPayload: async (payload: unknown, original: Model<Api>) => {
			const body = { ...(payload as object), model: name };
			return (await options?.onPayload?.(body, original)) ?? body;
		},
	} as O;
}
function azureCompletions(): ProviderStreams {
	const api = openAICompletionsApi();
	return {
		stream: (model, context, options) =>
			lazyStream(model, async () =>
				api.stream({ ...model, baseUrl: resolveAzureBaseUrl(model, options) }, context, deployment(model, options)),
			),
		streamSimple: (model, context, options) =>
			lazyStream(model, async () =>
				api.streamSimple(
					{ ...model, baseUrl: resolveAzureBaseUrl(model, options) },
					context,
					deployment(model, options),
				),
			),
	};
}
export function azureProvider(): Provider<"azure-openai-responses" | "openai-completions"> {
	return createProvider({
		id: "azure",
		name: "Azure",
		models: Object.values(AZURE_MODELS),
		auth: { apiKey: envApiKeyAuth("Azure OpenAI API key", ["AZURE_OPENAI_API_KEY"]) },
		api: { "azure-openai-responses": azureOpenAIResponsesApi(), "openai-completions": azureCompletions() },
	});
}
