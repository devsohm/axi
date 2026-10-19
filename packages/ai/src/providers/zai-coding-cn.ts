import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { ZAI_CODING_CN_MODELS } from "./zai-coding-cn.models.ts";

export function zaiCodingCnProvider(): Provider<"openai-completions"> {
	const auth = envApiKeyAuth("Z.AI Coding CN API key", ["ZAI_CODING_CN_API_KEY"]);
	return createProvider({
		id: "zai-coding-cn",
		name: "Z.AI Coding CN",
		baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
		models: Object.values(ZAI_CODING_CN_MODELS),
		api: openAICompletionsApi(),
		auth: { apiKey: auth },
	});
}
