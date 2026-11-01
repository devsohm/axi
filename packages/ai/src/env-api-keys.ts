import type { ProviderEnv } from "./types.ts";
import { getProviderEnvValue } from "./utils/provider-env.ts";

export const ANTHROPIC_AUTH_TOKEN_ENV = "ANTHROPIC_AUTH_TOKEN";
export const ANTHROPIC_OAUTH_TOKEN_ENV = "ANTHROPIC_OAUTH_TOKEN";
export const ANTHROPIC_API_KEY_ENV = "ANTHROPIC_API_KEY";
export const ANTHROPIC_FEDERATION_RULE_ID_ENV = "ANTHROPIC_FEDERATION_RULE_ID";
export const ANTHROPIC_ORGANIZATION_ID_ENV = "ANTHROPIC_ORGANIZATION_ID";
export const ANTHROPIC_SERVICE_ACCOUNT_ID_ENV = "ANTHROPIC_SERVICE_ACCOUNT_ID";
export const ANTHROPIC_IDENTITY_TOKEN_FILE_ENV = "ANTHROPIC_IDENTITY_TOKEN_FILE";
export const ANTHROPIC_WORKSPACE_ID_ENV = "ANTHROPIC_WORKSPACE_ID";

const keys: Readonly<Record<string, readonly string[]>> = {
	"github-copilot": ["COPILOT_GITHUB_TOKEN"],
	anthropic: [ANTHROPIC_AUTH_TOKEN_ENV, ANTHROPIC_OAUTH_TOKEN_ENV, ANTHROPIC_API_KEY_ENV],
	"ant-ling": ["ANT_LING_API_KEY"],
	"qwen-token-plan": ["QWEN_TOKEN_PLAN_API_KEY"],
	"qwen-token-plan-cn": ["QWEN_TOKEN_PLAN_CN_API_KEY"],
	"qwen-token-plan-individual": ["QWEN_TOKEN_PLAN_API_KEY"],
	openai: ["OPENAI_API_KEY"],
	azure: ["AZURE_OPENAI_API_KEY"],
	nvidia: ["NVIDIA_API_KEY"],
	deepseek: ["DEEPSEEK_API_KEY"],
	google: ["GEMINI_API_KEY"],
	"google-vertex": ["GOOGLE_CLOUD_API_KEY"],
	groq: ["GROQ_API_KEY"],
	cerebras: ["CEREBRAS_API_KEY"],
	xai: ["XAI_API_KEY"],
	typesafe: ["TYPESAFE_API_KEY"],
	openrouter: ["OPENROUTER_API_KEY"],
	"vercel-ai-gateway": ["AI_GATEWAY_API_KEY"],
	zai: ["ZAI_API_KEY"],
	"zai-coding-cn": ["ZAI_CODING_CN_API_KEY"],
	mistral: ["MISTRAL_API_KEY"],
	minimax: ["MINIMAX_API_KEY"],
	"minimax-cn": ["MINIMAX_CN_API_KEY"],
	moonshotai: ["MOONSHOT_API_KEY"],
	"moonshotai-cn": ["MOONSHOT_API_KEY"],
	huggingface: ["HF_TOKEN"],
	fireworks: ["FIREWORKS_API_KEY"],
	together: ["TOGETHER_API_KEY"],
	baseten: ["BASETEN_API_KEY"],
	opencode: ["OPENCODE_API_KEY"],
	"opencode-go": ["OPENCODE_API_KEY"],
	"kimi-coding": ["KIMI_API_KEY"],
	meta: ["META_API_KEY"],
	"cloudflare-workers-ai": ["CLOUDFLARE_API_KEY"],
	"cloudflare-ai-gateway": ["CLOUDFLARE_API_KEY"],
	xiaomi: ["XIAOMI_API_KEY"],
	"xiaomi-token-plan-cn": ["XIAOMI_TOKEN_PLAN_CN_API_KEY"],
	"xiaomi-token-plan-ams": ["XIAOMI_TOKEN_PLAN_AMS_API_KEY"],
	"xiaomi-token-plan-sgp": ["XIAOMI_TOKEN_PLAN_SGP_API_KEY"],
};
let exists: typeof import("node:fs").existsSync | undefined;
let home: typeof import("node:os").homedir | undefined;
let join: typeof import("node:path").join | undefined;
let cachedAdc: boolean | undefined;
const nodeRuntime = typeof process !== "undefined" && !!process.versions?.node;
const load = (specifier: string) => import(specifier);
if (nodeRuntime) {
	void load("node:" + "fs").then((module) => {
		exists = module.existsSync;
	});
	void load("node:" + "os").then((module) => {
		home = module.homedir;
	});
	void load("node:" + "path").then((module) => {
		join = module.join;
	});
}
function adc(env?: ProviderEnv): boolean {
	if (env?.GOOGLE_APPLICATION_CREDENTIALS) return exists?.(env.GOOGLE_APPLICATION_CREDENTIALS) ?? false;
	if (cachedAdc !== undefined) return cachedAdc;
	if (!exists || !home || !join) {
		if (!nodeRuntime) cachedAdc = false;
		return false;
	}
	const path =
		getProviderEnvValue("GOOGLE_APPLICATION_CREDENTIALS", env) ||
		join(home(), ".config", "gcloud", "application_default_credentials.json");
	return (cachedAdc = exists(path));
}
export function findEnvKeys(provider: string, env?: ProviderEnv): string[] | undefined {
	if (!Object.hasOwn(keys, provider)) return undefined;
	const found = keys[provider].filter((key) => !!getProviderEnvValue(key, env));
	return found.length ? found : undefined;
}
export function getEnvApiKey(provider: string, env?: ProviderEnv): string | undefined {
	const key = findEnvKeys(provider, env)?.find((name) => provider !== "anthropic" || name !== ANTHROPIC_AUTH_TOKEN_ENV);
	if (key) return getProviderEnvValue(key, env);
	const configured = (name: string) => getProviderEnvValue(name, env);
	if (
		provider === "google-vertex" &&
		adc(env) &&
		(configured("GOOGLE_CLOUD_PROJECT") || configured("GCLOUD_PROJECT")) &&
		configured("GOOGLE_CLOUD_LOCATION")
	)
		return "<authenticated>";
	if (
		provider === "amazon-bedrock" &&
		(configured("AWS_PROFILE") ||
			(configured("AWS_ACCESS_KEY_ID") && configured("AWS_SECRET_ACCESS_KEY")) ||
			[
				"AWS_BEARER_TOKEN_BEDROCK",
				"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
				"AWS_CONTAINER_CREDENTIALS_FULL_URI",
				"AWS_WEB_IDENTITY_TOKEN_FILE",
			].some(configured))
	)
		return "<authenticated>";
	return undefined;
}
