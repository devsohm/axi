import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { HUGGINGFACE_MODELS } from "./huggingface.models.ts";

export function huggingfaceProvider(): Provider<"openai-completions"> {
	const auth = envApiKeyAuth("Hugging Face token", ["HF_TOKEN"]);
	return createProvider({
		id: "huggingface",
		name: "Hugging Face",
		baseUrl: "https://router.huggingface.co/v1",
		models: Object.values(HUGGINGFACE_MODELS),
		api: openAICompletionsApi(),
		auth: { apiKey: auth },
	});
}
