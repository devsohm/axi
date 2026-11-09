import type { OAuthAuth } from "../types.ts";

type OAuthFlowLoaders = Record<"anthropic" | "openaiCodex" | "githubCopilot" | "openrouter" | "kimiCoding" | "meta" | "xai", () => OAuthAuth | Promise<OAuthAuth>>;
let bundled: OAuthFlowLoaders | undefined;
export function registerBundledOAuthFlowLoaders(loaders: OAuthFlowLoaders): void {
	bundled = loaders;
}

async function flow<K extends string>(file: string, exported: K): Promise<OAuthAuth> {
	const suffix = import.meta.url.endsWith(".js") ? "js" : "ts";
	const specifier = `./${file}.${suffix}`;
	const loaded: Record<K, OAuthAuth> = await import(new URL(specifier, import.meta.url).href);
	return loaded[exported];
}
export const loadAnthropicOAuth = async (): Promise<OAuthAuth> => bundled ? bundled.anthropic() : flow("anthropic", "anthropicOAuth");
export const loadOpenAICodexOAuth = async (): Promise<OAuthAuth> => bundled ? bundled.openaiCodex() : flow("openai-codex", "openaiCodexOAuth");
export const loadGitHubCopilotOAuth = async (): Promise<OAuthAuth> => bundled ? bundled.githubCopilot() : flow("github-copilot", "githubCopilotOAuth");
export const loadOpenRouterOAuth = async (): Promise<OAuthAuth> => bundled ? bundled.openrouter() : flow("openrouter", "openRouterOAuth");
export const loadKimiCodingOAuth = async (): Promise<OAuthAuth> => bundled ? bundled.kimiCoding() : flow("kimi-coding", "kimiCodingOAuth");
export const loadMetaOAuth = async (): Promise<OAuthAuth> => bundled ? bundled.meta() : flow("meta", "metaOAuth");
export const loadXaiOAuth = async (): Promise<OAuthAuth> => bundled ? bundled.xai() : flow("xai", "xaiOAuth");
