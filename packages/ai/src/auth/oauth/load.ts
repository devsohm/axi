import type { OAuthAuth } from "../types.ts";

async function flow<K extends string>(file: string, exported: K): Promise<OAuthAuth> {
	const suffix = import.meta.url.endsWith(".js") ? "js" : "ts";
	const specifier = `./${file}.${suffix}`;
	const loaded: Record<K, OAuthAuth> = await import(specifier);
	return loaded[exported];
}
export const loadAnthropicOAuth = (): Promise<OAuthAuth> => flow("anthropic", "anthropicOAuth");
export const loadOpenAICodexOAuth = (): Promise<OAuthAuth> => flow("openai-codex", "openaiCodexOAuth");
export const loadGitHubCopilotOAuth = (): Promise<OAuthAuth> => flow("github-copilot", "githubCopilotOAuth");
export const loadOpenRouterOAuth = (): Promise<OAuthAuth> => flow("openrouter", "openRouterOAuth");
export const loadKimiCodingOAuth = (): Promise<OAuthAuth> => flow("kimi-coding", "kimiCodingOAuth");
export const loadMetaOAuth = (): Promise<OAuthAuth> => flow("meta", "metaOAuth");
export const loadXaiOAuth = (): Promise<OAuthAuth> => flow("xai", "xaiOAuth");
