import { clampThinkingLevel } from "../models.ts";
import type {
	Api,
	Model,
	ModelThinkingLevel,
	SamplingParams,
	SimpleStreamOptions,
	StreamOptions,
	ThinkingBudgets,
	ThinkingLevel,
	TranscriptContext,
} from "../types.ts";
import { estimateContextTokens } from "../utils/estimate.ts";
export function clampMaxTokensToContext(model: Model<Api>, context: TranscriptContext, maxTokens: number): number {
	return model.contextWindow <= 0
		? Math.max(1, maxTokens)
		: Math.min(maxTokens, Math.max(1, model.contextWindow - estimateContextTokens(context).tokens - 4096));
}
export function resolveSamplingParams(
	model: Model<Api>,
	level: ModelThinkingLevel,
	requestParams?: SamplingParams,
): SamplingParams | undefined {
	const effectiveLevel = clampThinkingLevel(model, level);
	const selected = model.samplingParamsByThinkingLevel?.[effectiveLevel];
	return model.samplingParams || selected || requestParams
		? { ...model.samplingParams, ...selected, ...requestParams }
		: undefined;
}
export function buildBaseOptions(
	model: Model<Api>,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
	apiKey?: string,
): StreamOptions {
	const samplingParams = resolveSamplingParams(model, options?.reasoning ?? "off", options?.samplingParams);
	return {
		temperature: options?.temperature,
		samplingParams,
		maxTokens: clampMaxTokensToContext(model, context, options?.maxTokens ?? model.maxTokens),
		signal: options?.signal,
		telemetry: options?.telemetry,
		identity: options?.identity,
		apiKey: apiKey || options?.apiKey,
		fetch: options?.fetch,
		transport: options?.transport,
		cacheRetention: options?.cacheRetention,
		sessionId: options?.sessionId,
		headers: options?.headers,
		onPayload: options?.onPayload,
		onResponse: options?.onResponse,
		onProviderStreamEvent: options?.onProviderStreamEvent,
		timeoutMs: options?.timeoutMs,
		websocketConnectTimeoutMs: options?.websocketConnectTimeoutMs,
		maxRetries: options?.maxRetries,
		maxRetryDelayMs: options?.maxRetryDelayMs,
		metadata: options?.metadata,
		env: options?.env,
	};
}
export const MIN_ANSWER_TOKENS = 1024;
export const DEFAULT_THINKING_BUDGETS: ThinkingBudgets = { minimal: 1024, low: 2048, medium: 8192, high: 16384 };
export function clampReasoning(level: ThinkingLevel | undefined): Exclude<ThinkingLevel, "xhigh" | "max"> | undefined {
	return level === "xhigh" || level === "max" ? "high" : level;
}
export function thinkingBudgetForLevel(level: ThinkingLevel, customBudgets?: ThinkingBudgets): number {
	return { ...DEFAULT_THINKING_BUDGETS, ...customBudgets }[clampReasoning(level)!]!;
}
export function clampThinkingBudgetToAnswerRoom(budget: number, ceiling: number): number {
	return Math.min(budget, Math.max(0, ceiling - MIN_ANSWER_TOKENS));
}
export function adjustMaxTokensForThinking(
	baseMaxTokens: number | undefined,
	modelMaxTokens: number,
	level: ThinkingLevel,
	customBudgets?: ThinkingBudgets,
): { maxTokens: number; thinkingBudget: number } {
	const budget = thinkingBudgetForLevel(level, customBudgets);
	const maxTokens = baseMaxTokens === undefined ? modelMaxTokens : Math.min(baseMaxTokens + budget, modelMaxTokens);
	return {
		maxTokens,
		thinkingBudget: maxTokens <= budget ? clampThinkingBudgetToAnswerRoom(budget, maxTokens) : budget,
	};
}
