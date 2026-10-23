import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import {
	CLOUDFLARE_AI_GATEWAY_ANTHROPIC_BASE_URL,
	CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL,
	CLOUDFLARE_AI_GATEWAY_OPENAI_BASE_URL,
	CLOUDFLARE_WORKERS_AI_BASE_URL,
} from "../src/api/cloudflare.ts";
import type { Api, Model, ModelCost, OpenAICompletionsCompat, ThinkingLevelMap } from "../src/types.ts";
import { individualModels } from "./catalog-config.ts";
import { anthropicMetadata, fireworksAdaptive } from "./catalog-metadata.ts";
import { getEffortThinkingLevelMap, type ModelsDevReasoningOption } from "./models-dev-reasoning-options.ts";

const rates = {
	input: Type.Optional(Type.Number()),
	output: Type.Optional(Type.Number()),
	cache_read: Type.Optional(Type.Number()),
	cache_write: Type.Optional(Type.Number()),
};
const reasoningOption = Type.Union([
	Type.Object({ type: Type.Literal("toggle") }),
	Type.Object({
		type: Type.Literal("budget_tokens"),
		min: Type.Optional(Type.Number()),
		max: Type.Optional(Type.Number()),
	}),
	Type.Object({
		type: Type.Literal("effort"),
		values: Type.Array(
			Type.Union([
				Type.Literal("none"),
				Type.Literal("minimal"),
				Type.Literal("low"),
				Type.Literal("medium"),
				Type.Literal("high"),
				Type.Literal("xhigh"),
				Type.Literal("max"),
				Type.Literal("default"),
				Type.Null(),
			]),
		),
	}),
]);
const sourceSchema = Type.Object({
	id: Type.Optional(Type.String()),
	name: Type.Optional(Type.String()),
	tool_call: Type.Optional(Type.Boolean()),
	structured_output: Type.Optional(Type.Boolean()),
	reasoning: Type.Optional(Type.Boolean()),
	reasoning_options: Type.Optional(Type.Array(reasoningOption)),
	status: Type.Optional(Type.String()),
	limit: Type.Optional(Type.Object({ context: Type.Optional(Type.Number()), output: Type.Optional(Type.Number()) })),
	cost: Type.Optional(
		Type.Object({
			...rates,
			tiers: Type.Optional(
				Type.Array(
					Type.Object({
						...rates,
						tier: Type.Optional(
							Type.Object({ type: Type.Optional(Type.String()), size: Type.Optional(Type.Number()) }),
						),
					}),
				),
			),
		}),
	),
	modalities: Type.Optional(
		Type.Object({ input: Type.Optional(Type.Array(Type.String())), output: Type.Optional(Type.Array(Type.String())) }),
	),
	provider: Type.Optional(Type.Object({ npm: Type.Optional(Type.Union([Type.String(), Type.Null()])) })),
});
const catalogSchema = Type.Record(
	Type.String(),
	Type.Object({ models: Type.Optional(Type.Record(Type.String(), sourceSchema)) }),
);
export type SourceModel = Static<typeof sourceSchema>;
export type SourceCatalog = Static<typeof catalogSchema>;
export function parseModelsDev(value: unknown): SourceCatalog {
	if (!Value.Check(catalogSchema, value)) throw new Error("Invalid model catalog response");
	return value;
}
export function sourceCost(cost: SourceModel["cost"]): ModelCost {
	const base = {
		input: cost?.input || 0,
		output: cost?.output || 0,
		cacheRead: cost?.cache_read || 0,
		cacheWrite: cost?.cache_write || 0,
	};
	const tiers = cost?.tiers?.flatMap((row) =>
		row.tier?.type === "context" && row.tier.size !== undefined
			? [
					{
						inputTokensAbove: row.tier.size,
						input: row.input ?? base.input,
						output: row.output ?? base.output,
						cacheRead: row.cache_read ?? base.cacheRead,
						cacheWrite: row.cache_write ?? base.cacheWrite,
					},
				]
			: [],
	);
	return tiers?.length ? { ...base, tiers } : base;
}
function chat(source: SourceModel, provider: string, id: string, api: Api, baseUrl: string): Model<Api> {
	return {
		id,
		name: source.name || id,
		provider,
		api,
		baseUrl,
		reasoning: source.reasoning === true,
		input: source.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
		cost: sourceCost(source.cost),
		contextWindow: source.limit?.context || 4096,
		maxTokens: source.limit?.output || 4096,
	};
}
const kimiBase: OpenAICompletionsCompat = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	maxTokensField: "max_tokens",
	supportsStrictMode: false,
	thinkingFormat: "deepseek",
};
const kimiEffort: OpenAICompletionsCompat = {
	...kimiBase,
	requiresReasoningContentOnAssistantMessages: true,
	thinkingFormat: "openai",
	supportsReasoningEffort: true,
};
export const kimiCost = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 };
const copilotHeaders = {
	"User-Agent": "GitHubCopilotChat/0.35.0",
	"Editor-Version": "vscode/1.107.0",
	"Editor-Plugin-Version": "copilot-chat/0.35.0",
	"Copilot-Integration-Id": "vscode-chat",
};
const togetherBase: OpenAICompletionsCompat = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	maxTokensField: "max_tokens",
	supportsStrictMode: false,
	supportsLongCacheRetention: false,
};
const nvidiaExcluded = new Set([
	"abacusai/dracarys-llama-3.1-70b-instruct",
	"bytedance/seed-oss-36b-instruct",
	"deepseek-ai/deepseek-v4-flash",
	"deepseek-ai/deepseek-v4-pro",
	"google/gemma-2-2b-it",
	"google/gemma-3n-e2b-it",
	"google/gemma-3n-e4b-it",
	"google/gemma-4-31b-it",
	"meta/llama-3.2-1b-instruct",
	"meta/llama-4-maverick-17b-128e-instruct",
	"microsoft/phi-4-mini-instruct",
	"minimaxai/minimax-m2.7",
	"mistralai/mistral-nemotron",
	"nvidia/nemotron-mini-4b-instruct",
	"qwen/qwen3-next-80b-a3b-instruct",
	"qwen/qwen3.5-397b-a17b",
	"sarvamai/sarvam-m",
	"upstage/solar-10.7b-instruct",
]);
const endpoints: Record<string, [Api, string]> = {
	"amazon-bedrock": ["bedrock-converse-stream", "https://bedrock-runtime.us-east-1.amazonaws.com"],
	anthropic: ["anthropic-messages", "https://api.anthropic.com"],
	google: ["google-generative-ai", "https://generativelanguage.googleapis.com/v1beta"],
	"google-vertex": ["google-vertex", "https://{location}-aiplatform.googleapis.com"],
	openai: ["openai-responses", "https://api.openai.com/v1"],
	groq: ["openai-completions", "https://api.groq.com/openai/v1"],
	cerebras: ["openai-completions", "https://api.cerebras.ai/v1"],
	"cloudflare-workers-ai": ["openai-completions", CLOUDFLARE_WORKERS_AI_BASE_URL],
	xai: ["openai-responses", "https://api.x.ai/v1"],
	meta: ["openai-responses", "https://api.meta.ai/v1"],
	mistral: ["mistral-conversations", "https://api.mistral.ai"],
	huggingface: ["openai-completions", "https://router.huggingface.co/v1"],
	nvidia: ["openai-completions", "https://integrate.api.nvidia.com/v1"],
	baseten: ["openai-completions", "https://inference.baseten.co/v1"],
	minimax: ["anthropic-messages", "https://api.minimax.io/anthropic"],
	"minimax-cn": ["anthropic-messages", "https://api.minimaxi.com/anthropic"],
	moonshotai: ["openai-completions", "https://api.moonshot.ai/v1"],
	"moonshotai-cn": ["openai-completions", "https://api.moonshot.cn/v1"],
	xiaomi: ["openai-completions", "https://api.xiaomimimo.com/v1"],
};
for (const region of ["cn", "ams", "sgp"])
	endpoints[`xiaomi-token-plan-${region}`] = ["openai-completions", `https://token-plan-${region}.xiaomimimo.com/v1`];
const nvidiaId = (id: string) => id.toLowerCase().replaceAll("_", ".");
const hiddenMiniMax = new Set(["MiniMax-M2", "MiniMax-M2.1", "MiniMax-M2.5", "MiniMax-M2.5-highspeed"]);
export function buildModelsDevCatalog(data: SourceCatalog, nvidiaIds: readonly string[] = []) {
	const liveNvidiaIds = new Map<string, string>();
	for (const id of nvidiaIds) {
		liveNvidiaIds.set(id, id);
		liveNvidiaIds.set(nvidiaId(id), id);
	}
	const models: Model<Api>[] = [],
		options = new Map<string, ModelsDevReasoningOption[]>();
	const emit = (model: Model<Api>, source: SourceModel) => {
		models.push(model);
		if (
			source.reasoning_options !== undefined &&
			!["baseten", "mistral", "kimi-coding", "google", "google-vertex", "minimax", "minimax-cn"].includes(
				model.provider,
			) &&
			!model.provider.startsWith("xiaomi")
		)
			options.set(`${model.provider}:${model.id}`, source.reasoning_options);
	};
	for (const [provider, [api, baseUrl]] of Object.entries(endpoints)) {
		const entries = data[provider]?.models ?? {};
		for (const [id, source] of Object.entries(entries)) {
			if (provider === "baseten" ? source.status === "deprecated" : source.tool_call !== true) continue;
			if ((provider === "minimax" || provider === "minimax-cn") && hiddenMiniMax.has(id)) continue;
			if (provider.startsWith("xiaomi") && source.status === "deprecated") continue;
			if (provider === "openai" && id === "gpt-5.6") continue;
			if (
				provider === "amazon-bedrock" &&
				(id === "anthropic.claude-opus-5" ||
					id.startsWith("ai21.jamba") ||
					id.startsWith("mistral.mistral-7b-instruct-v0"))
			)
				continue;
			if (provider === "google-vertex" && (!id.startsWith("gemini-") || id === "gemini-3.1-flash-lite-preview"))
				continue;
			const googleSource =
				provider === "google" || provider === "google-vertex"
					? (entries[
							id === "gemini-flash-latest"
								? "gemini-3.5-flash"
								: id === "gemini-flash-lite-latest"
									? "gemini-3.1-flash-lite"
									: id
						] ?? source)
					: source;
			const model = chat(googleSource, provider, id, api, baseUrl);
			model.name = source.name || id;
			if (provider === "minimax" || provider === "minimax-cn") {
				const map = getEffortThinkingLevelMap(source.reasoning_options ?? []);
				if (map) {
					model.thinkingLevelMap = map;
					model.compat = { forceAdaptiveThinking: true };
				}
			}
			if (provider === "amazon-bedrock") {
				if (id.startsWith("eu.")) model.baseUrl = "https://bedrock-runtime.eu-central-1.amazonaws.com";
				if (source.structured_output) model.compat = { supportsStrictMode: true };
			}
			if (provider === "google" || provider === "google-vertex") {
				const effort = getEffortThinkingLevelMap(googleSource.reasoning_options ?? []);
				if (effort) model.thinkingLevelMap = effort;
				else if (/gemma-?4/.test(id.toLowerCase()))
					model.thinkingLevelMap = { off: null, minimal: "MINIMAL", low: null, medium: null, high: "HIGH" };
				if (provider === "google-vertex")
					model.cost = {
						input: googleSource.cost?.input || 0,
						output: googleSource.cost?.output || 0,
						cacheRead: id === "gemini-2.5-flash" ? 0.03 : googleSource.cost?.cache_read || 0,
						cacheWrite: 0,
					};
			}
			if (provider === "cloudflare-workers-ai") model.compat = { sendSessionAffinityHeaders: true };
			if (provider === "xai") model.compat = { supportsLongCacheRetention: false };
			if (provider === "huggingface") model.compat = { supportsDeveloperRole: false };
			if (provider === "mistral") {
				const map = getEffortThinkingLevelMap(source.reasoning_options ?? []);
				if (map) model.thinkingLevelMap = map;
				model.cost = {
					input: source.cost?.input || 0,
					output: source.cost?.output || 0,
					cacheRead: source.cost?.cache_read ?? (source.cost?.input ? Number((source.cost.input * 0.1).toFixed(6)) : 0),
					cacheWrite: source.cost?.cache_write || 0,
				};
			}
			if (provider === "nvidia") {
				const live = liveNvidiaIds.get(id) ?? liveNvidiaIds.get(nvidiaId(id));
				if (
					!live ||
					nvidiaExcluded.has(live) ||
					!source.modalities?.input?.includes("text") ||
					!source.modalities.output?.includes("text")
				)
					continue;
				model.id = live;
				model.name = source.name || live;
				model.headers = { "NVCF-POLL-SECONDS": "3600" };
				model.compat = { ...togetherBase };
			}
			if (provider.startsWith("moonshotai")) {
				const k3 = id === "kimi-k3";
				model.reasoning ||= k3;
				model.compat = k3 ? { ...kimiEffort } : { ...kimiBase };
				model.cost = k3
					? { ...kimiCost }
					: {
							input: source.cost?.input || 0,
							output: source.cost?.output || 0,
							cacheRead: source.cost?.cache_read || 0,
							cacheWrite: source.cost?.cache_write || 0,
						};
			}
			if (provider.startsWith("xiaomi")) {
				model.compat = {
					supportsReasoningEffort: false,
					requiresReasoningContentOnAssistantMessages: true,
					thinkingFormat: "deepseek",
				};
				if (model.reasoning)
					model.thinkingLevelMap = {
						off: "off",
						minimal: null,
						low: null,
						medium: null,
						high: "high",
						xhigh: null,
						max: null,
					};
			}
			if (provider === "baseten") {
				const glm = ["zai-org/GLM-5.2", "zai-org/GLM-5.2-Fast"].includes(id),
					controls = source.reasoning_options ?? [],
					toggle = glm || controls.some((option) => option.type === "toggle"),
					effort = glm || controls.some((option) => option.type === "effort");
				model.compat = {
					...togetherBase,
					supportsUsageInStreaming: true,
					supportsStrictMode: true,
					sendSessionAffinityHeaders: true,
					...(effort ? { supportsReasoningEffort: true, thinkingFormat: "openai" } : {}),
					...(toggle
						? { thinkingFormat: "baseten", chatTemplateArgs: { enable_thinking: { $var: "thinking.enabled" } } }
						: {}),
				};
				const map: ThinkingLevelMap | undefined = glm
					? { off: "none", minimal: null, low: null, medium: null, high: "high", xhigh: null, max: "max" }
					: toggle
						? { off: "off", minimal: null, low: null, medium: null, high: "high", xhigh: null, max: null }
						: getEffortThinkingLevelMap(controls);
				if (map) model.thinkingLevelMap = map;
				if (glm) model.input = ["text"];
			}
			emit(model, source);
		}
	}
	for (const [id, source] of Object.entries(data["fireworks-ai"]?.models ?? {})) {
		if (!source.tool_call) continue;
		const completion = id.includes("glm-") || id.includes("kimi-k3"),
			model = chat(
				source,
				"fireworks",
				id,
				completion ? "openai-completions" : "anthropic-messages",
				`https://api.fireworks.ai/inference${completion ? "/v1" : ""}`,
			);
		model.compat = completion
			? {
					supportsStore: false,
					supportsDeveloperRole: false,
					sendSessionAffinityHeaders: true,
					supportsLongCacheRetention: false,
					...(id.includes("kimi-k3")
						? { requiresReasoningContentOnAssistantMessages: true, thinkingFormat: "openai" }
						: {}),
				}
			: {
					allowEmptySignature: true,
					sendSessionAffinityHeaders: true,
					supportsEagerToolInputStreaming: false,
					supportsCacheControlOnTools: false,
					supportsLongCacheRetention: false,
					...(fireworksAdaptive(id, source.reasoning_options ?? []) ? { forceAdaptiveThinking: true } : {}),
				};
		emit(model, source);
	}
	for (const [key, provider, url] of [
		["zai-coding-plan", "zai", "https://api.z.ai/api/coding/paas/v4"],
		["zhipuai-coding-plan", "zai-coding-cn", "https://open.bigmodel.cn/api/coding/paas/v4"],
	]) {
		for (const [id, source] of Object.entries(data[key]?.models ?? {})) {
			if (!source.tool_call) continue;
			const model = chat(source, provider, id, "openai-completions", url),
				map = getEffortThinkingLevelMap(source.reasoning_options ?? []);
			if (map && ["glm-5.2", "glm-5.2-highspeed"].includes(id)) map.off = "none";
			if (map) model.thinkingLevelMap = map;
			model.cost = sourceCost(data.zai?.models?.[id]?.cost ?? source.cost);
			model.compat = {
				supportsDeveloperRole: false,
				thinkingFormat: "zai",
				...(map ? { supportsReasoningEffort: true } : {}),
				...(!["glm-4.5", "glm-4.5-air", "glm-4.5-flash", "glm-4.5v"].includes(id) ? { zaiToolStream: true } : {}),
			};
			emit(model, source);
		}
	}
	const together = data.together ?? data.togetherai ?? data["together-ai"];
	for (const [id, source] of Object.entries(together?.models ?? {})) {
		if (!source.tool_call || source.status === "deprecated") continue;
		const model = chat(source, "together", id, "openai-completions", "https://api.together.ai/v1");
		const effort = ["openai/gpt-oss-20b", "openai/gpt-oss-120b"].includes(id),
			both = id === "deepseek-ai/DeepSeek-V4-Pro-0813";
		model.compat = {
			...togetherBase,
			...(model.reasoning
				? {
						thinkingFormat: effort ? "openai" : "together",
						...(effort || both ? { supportsReasoningEffort: true } : {}),
					}
				: {}),
		};
		if (model.reasoning)
			model.thinkingLevelMap = effort
				? { off: null, minimal: null }
				: both
					? { minimal: null, low: null, medium: null, high: "high", xhigh: null }
					: { minimal: null, low: null, medium: null };
		emit(model, source);
	}
	for (const [id, source] of Object.entries(data["kimi-code-plan-global"]?.models ?? {})) {
		if (!source.tool_call) continue;
		const style = ["k3", "k3-256k", "kimi-for-coding"].includes(id),
			model = chat(source, "kimi-coding", id, "openai-completions", "https://api.kimi.com/coding/v1");
		model.compat = {
			...(style ? kimiEffort : kimiBase),
			supportsMidConvoSystemMessages: true,
			...(style ? { supportsMidConvoToolAdditions: true } : {}),
		};
		const implied =
			id === "k3"
				? kimiCost
				: id === "kimi-for-coding"
					? { input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0 }
					: id === "kimi-for-coding-highspeed"
						? { input: 1.9, output: 8, cacheRead: 0.38, cacheWrite: 0 }
						: undefined;
		model.cost = {
			input: source.cost?.input || implied?.input || 0,
			output: source.cost?.output || implied?.output || 0,
			cacheRead: source.cost?.cache_read || implied?.cacheRead || 0,
			cacheWrite: source.cost?.cache_write || implied?.cacheWrite || 0,
		};
		model.thinkingLevelMap = {
			...(style && source.reasoning_options ? getEffortThinkingLevelMap(source.reasoning_options) : {}),
			off: null,
		};
		emit(model, source);
	}
	for (const provider of ["opencode", "opencode-go"])
		for (const [id, source] of Object.entries(data[provider]?.models ?? {})) {
			if (!source.tool_call || source.status === "deprecated") continue;
			const npm = source.provider?.npm,
				base = `https://opencode.ai/inference${provider === "opencode-go" ? "/go" : ""}`;
			let api: Api =
				npm === "@ai-sdk/anthropic"
					? "anthropic-messages"
					: npm === "@ai-sdk/google"
						? "google-generative-ai"
						: npm === "@ai-sdk/openai"
							? "openai-responses"
							: "openai-completions";
			let compat: Model<Api>["compat"] =
				api === "openai-responses"
					? { sessionAffinityFormat: "openai-nosession" }
					: npm === "@ai-sdk/alibaba"
						? { cacheControlFormat: "anthropic" }
						: undefined;
			if (provider === "opencode" && id === "grok-build-0.1") compat = { ...compat, supportsReasoningEffort: false };
			if (id === "kimi-k2.6") compat = { ...compat, thinkingFormat: "deepseek", supportsReasoningEffort: false };
			if (provider === "opencode-go" && ["qwen3.5-plus", "qwen3.6-plus"].includes(id)) {
				api = "openai-completions";
				compat = { ...compat, thinkingFormat: "qwen" };
			}
			if (api === "openai-completions") {
				compat = { ...compat, maxTokensField: "max_tokens" };
				if (
					[
						"opencode:deepseek-v4-flash",
						"opencode:deepseek-v4-pro",
						"opencode:kimi-k2.5",
						"opencode:kimi-k2.6",
						"opencode:minimax-m2.7",
						"opencode-go:kimi-k2.6",
					].includes(`${provider}:${id}`)
				)
					compat = { ...compat, supportsLongCacheRetention: false };
			}
			const model = chat(source, provider, id, api, api === "anthropic-messages" ? base : `${base}/v1`);
			if (compat) model.compat = compat;
			if (api === "google-generative-ai" || (provider === "opencode-go" && id === "deepseek-v4.1-flash")) {
				const map =
					getEffortThinkingLevelMap(source.reasoning_options ?? []) ??
					(api === "google-generative-ai" && /gemma-?4/.test(id.toLowerCase())
						? { off: null, minimal: "MINIMAL", low: null, medium: null, high: "HIGH" }
						: undefined);
				if (map) model.thinkingLevelMap = map;
			}
			emit(model, source);
		}
	for (const [id, source] of Object.entries(data["github-copilot"]?.models ?? {})) {
		if (!source.tool_call || source.status === "deprecated") continue;
		const api = /^claude-(haiku|sonnet|opus|fable)-[45]([.\-]|$)/.test(id)
			? "anthropic-messages"
			: /^(gpt-|grok-|oswe|mai-)/.test(id)
				? "openai-responses"
				: "openai-completions";
		const model = chat(source, "github-copilot", id, api, "https://api.individual.githubcopilot.com");
		model.contextWindow = source.limit?.context || 128000;
		model.maxTokens = source.limit?.output || 8192;
		model.headers = { ...copilotHeaders };
		if (api === "anthropic-messages") {
			const metadata = anthropicMetadata("github-copilot", id);
			if (Object.keys(metadata).length) model.compat = metadata;
		}
		if (api === "openai-completions")
			model.compat = { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false };
		emit(model, source);
	}
	const gateways = new Set<string>();
	for (const [id, source] of Object.entries(data["cloudflare-ai-gateway"]?.models ?? {})) {
		if (!source.tool_call) continue;
		const slash = id.indexOf("/"),
			kind = id.slice(0, slash),
			native = id.slice(slash + 1);
		if (slash < 0 || !["anthropic", "openai", "workers-ai"].includes(kind)) continue;
		const model = chat(
			source,
			"cloudflare-ai-gateway",
			kind === "anthropic" ? native.replaceAll(".", "-") : kind === "openai" ? native : id,
			kind === "anthropic" ? "anthropic-messages" : kind === "openai" ? "openai-responses" : "openai-completions",
			kind === "anthropic"
				? CLOUDFLARE_AI_GATEWAY_ANTHROPIC_BASE_URL
				: kind === "openai"
					? CLOUDFLARE_AI_GATEWAY_OPENAI_BASE_URL
					: CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL,
		);
		if (kind !== "openai") model.compat = { sendSessionAffinityHeaders: true };
		gateways.add(model.id);
		emit(model, source);
	}
	for (const [id, source] of Object.entries(data["cloudflare-workers-ai"]?.models ?? {}))
		if (source.tool_call && !gateways.has(`workers-ai/${id}`)) {
			const model = chat(
				source,
				"cloudflare-ai-gateway",
				`workers-ai/${id}`,
				"openai-completions",
				CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL,
			);
			model.compat = { sendSessionAffinityHeaders: true };
			emit(model, source);
		}
	for (const [key, provider, region, restricted] of [
		["alibaba-token-plan", "qwen-token-plan", "ap-southeast-1", false],
		["alibaba-token-plan", "qwen-token-plan-individual", "ap-southeast-1", true],
		["alibaba-token-plan-cn", "qwen-token-plan-cn", "cn-beijing", false],
	] as const) {
		for (const [id, source] of Object.entries(data[key]?.models ?? {})) {
			if (!source.tool_call || id === "qwen3.8-max-preview" || (restricted && !individualModels.has(id))) continue;
			const model = chat(
				source,
				provider,
				id,
				"openai-completions",
				`https://token-plan.${region}.maas.aliyuncs.com/compatible-mode/v1`,
			);
			const map =
				getEffortThinkingLevelMap(source.reasoning_options ?? []) ??
				(["glm-5", "glm-5.1"].includes(id)
					? { minimal: null, low: null, medium: null, high: "high", xhigh: null, max: "max" }
					: undefined);
			model.compat = {
				thinkingFormat: "qwen",
				supportsDeveloperRole: false,
				supportsStore: false,
				supportsReasoningEffort: map !== undefined,
			};
			if (map) model.thinkingLevelMap = map;
			emit(model, source);
		}
	}
	return { models, options };
}
