import { googleGenerativeAIApi } from "../api/google-generative-ai.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { GOOGLE_MODELS } from "./google.models.ts";

export function googleProvider(): Provider<"google-generative-ai"> {
	const auth = envApiKeyAuth("Gemini API key", ["GEMINI_API_KEY"]);
	return createProvider({
		id: "google",
		name: "Google",
		baseUrl: "https://generativelanguage.googleapis.com/v1beta",
		models: Object.values(GOOGLE_MODELS),
		api: googleGenerativeAIApi(),
		auth: { apiKey: auth },
	});
}
