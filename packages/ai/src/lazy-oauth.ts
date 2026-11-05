import { registerBundledOAuthFlowLoaders } from "./auth/oauth/load.ts";

export function registerLazyOAuthFlows(): void {
	registerBundledOAuthFlowLoaders({
		anthropic: () => import("./auth/oauth/anthropic.ts").then(module => module.anthropicOAuth),
		openaiCodex: () => import("./auth/oauth/openai-codex.ts").then(module => module.openaiCodexOAuth),
		githubCopilot: () => import("./auth/oauth/github-copilot.ts").then(module => module.githubCopilotOAuth),
		openrouter: () => import("./auth/oauth/openrouter.ts").then(module => module.openRouterOAuth),
		kimiCoding: () => import("./auth/oauth/kimi-coding.ts").then(module => module.kimiCodingOAuth),
		meta: () => import("./auth/oauth/meta.ts").then(module => module.metaOAuth),
		xai: () => import("./auth/oauth/xai.ts").then(module => module.xaiOAuth),
	});
}
