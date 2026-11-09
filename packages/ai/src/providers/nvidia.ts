import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { NVIDIA_MODELS } from "./nvidia.models.ts";

export function nvidiaProvider(): Provider<"openai-completions"> {
	const auth = envApiKeyAuth("NVIDIA API key", ["NVIDIA_API_KEY"]);
	return createProvider({
		id: "nvidia",
		name: "NVIDIA",
		baseUrl: "https://integrate.api.nvidia.com/v1",
		models: Object.values(NVIDIA_MODELS),
		api: openAICompletionsApi(),
		auth: { apiKey: auth },
	});
}
