import type { Provider } from "../models.ts";
import { amazonBedrockProvider } from "./amazon-bedrock.ts";
import { antLingProvider } from "./ant-ling.ts";
import { anthropicProvider } from "./anthropic.ts";
import { azureProvider } from "./azure.ts";
import { basetenProvider } from "./baseten.ts";
import { cerebrasProvider } from "./cerebras.ts";
import { cloudflareAIGatewayProvider } from "./cloudflare-ai-gateway.ts";
import { cloudflareWorkersAIProvider } from "./cloudflare-workers-ai.ts";
import { deepseekProvider } from "./deepseek.ts";
import { fireworksProvider } from "./fireworks.ts";
import { githubCopilotProvider } from "./github-copilot.ts";
import { googleProvider } from "./google.ts";
import { googleVertexProvider } from "./google-vertex.ts";
import { groqProvider } from "./groq.ts";
import { huggingfaceProvider } from "./huggingface.ts";
import { kimiCodingProvider } from "./kimi-coding.ts";
import { metaProvider } from "./meta.ts";
import { minimaxProvider } from "./minimax.ts";
import { minimaxCnProvider } from "./minimax-cn.ts";
import { mistralProvider } from "./mistral.ts";
import { moonshotaiProvider } from "./moonshotai.ts";
import { moonshotaiCnProvider } from "./moonshotai-cn.ts";
import { nvidiaProvider } from "./nvidia.ts";
import { openaiProvider } from "./openai.ts";
import { openaiCodexProvider } from "./openai-codex.ts";
import { opencodeProvider } from "./opencode.ts";
import { opencodeGoProvider } from "./opencode-go.ts";
import { openrouterProvider } from "./openrouter.ts";
import { qwenTokenPlanProvider } from "./qwen-token-plan.ts";
import { qwenTokenPlanCnProvider } from "./qwen-token-plan-cn.ts";
import { qwenTokenPlanIndividualProvider } from "./qwen-token-plan-individual.ts";
import { togetherProvider } from "./together.ts";
import { typesafeProvider } from "./typesafe.ts";
import { vercelAIGatewayProvider } from "./vercel-ai-gateway.ts";
import { xaiProvider } from "./xai.ts";
import { xiaomiProvider } from "./xiaomi.ts";
import { xiaomiTokenPlanAmsProvider } from "./xiaomi-token-plan-ams.ts";
import { xiaomiTokenPlanCnProvider } from "./xiaomi-token-plan-cn.ts";
import { xiaomiTokenPlanSgpProvider } from "./xiaomi-token-plan-sgp.ts";
import { zaiProvider } from "./zai.ts";
import { zaiCodingCnProvider } from "./zai-coding-cn.ts";
export const builtinProviders = (): Provider[] => [
	amazonBedrockProvider(),
	antLingProvider(),
	anthropicProvider(),
	azureProvider(),
	basetenProvider(),
	cerebrasProvider(),
	cloudflareAIGatewayProvider(),
	cloudflareWorkersAIProvider(),
	deepseekProvider(),
	fireworksProvider(),
	githubCopilotProvider(),
	googleProvider(),
	googleVertexProvider(),
	groqProvider(),
	huggingfaceProvider(),
	kimiCodingProvider(),
	metaProvider(),
	minimaxProvider(),
	minimaxCnProvider(),
	mistralProvider(),
	moonshotaiProvider(),
	moonshotaiCnProvider(),
	nvidiaProvider(),
	openaiProvider(),
	openaiCodexProvider(),
	opencodeProvider(),
	opencodeGoProvider(),
	openrouterProvider(),
	qwenTokenPlanProvider(),
	qwenTokenPlanCnProvider(),
	qwenTokenPlanIndividualProvider(),
	togetherProvider(),
	typesafeProvider(),
	vercelAIGatewayProvider(),
	xaiProvider(),
	xiaomiProvider(),
	xiaomiTokenPlanAmsProvider(),
	xiaomiTokenPlanCnProvider(),
	xiaomiTokenPlanSgpProvider(),
	zaiProvider(),
	zaiCodingCnProvider(),
];
