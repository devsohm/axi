import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses";
import type { StreamOptions, ThinkingBudgets, ThinkingLevel } from "../types.ts";

export type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type AnthropicThinkingDisplay = "summarized" | "omitted";
export interface AnthropicOptions extends StreamOptions {
	thinkingEnabled?: boolean;
	thinkingBudgetTokens?: number;
	effort?: AnthropicEffort;
	thinkingDisplay?: AnthropicThinkingDisplay;
	interleavedThinking?: boolean;
	toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string };
	client?: Anthropic;
}
export interface AzureEndpointOptions extends StreamOptions {
	azureApiVersion?: string;
	azureResourceName?: string;
	azureBaseUrl?: string;
	azureDeploymentName?: string;
}
export interface AzureOpenAIResponsesOptions extends AzureEndpointOptions {
	reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	toolChoice?: ResponseCreateParamsStreaming["tool_choice"];
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
}
export type BedrockThinkingDisplay = "summarized" | "omitted";
export interface BedrockOptions extends StreamOptions {
	region?: string;
	profile?: string;
	toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string };
	reasoning?: ThinkingLevel;
	thinkingBudgets?: ThinkingBudgets;
	interleavedThinking?: boolean;
	thinkingDisplay?: BedrockThinkingDisplay;
	requestMetadata?: Record<string, string>;
	bearerToken?: string;
}
export type GoogleApiThinkingLevel = "THINKING_LEVEL_UNSPECIFIED" | "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";
export type ResolvedGoogleThinkingLevel = Exclude<ThinkingLevel, "xhigh" | "max">;
export interface GoogleOptions extends StreamOptions {
	toolChoice?: "auto" | "none" | "any";
	thinking?: { enabled: boolean; budgetTokens?: number; level?: GoogleApiThinkingLevel };
}
export interface GoogleVertexOptions extends GoogleOptions {
	project?: string;
	location?: string;
}
export interface MistralOptions extends StreamOptions {
	toolChoice?: "auto" | "none" | "any" | "required" | { type: "function"; function: { name: string } };
	promptMode?: "reasoning";
	reasoningEffort?: "none" | "low" | "medium" | "high" | "max";
}
export interface OpenAICodexResponsesOptions extends StreamOptions {
	reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	reasoningSummary?: "auto" | "concise" | "detailed" | "off" | "on" | null;
	serviceTier?: ResponseCreateParamsStreaming["service_tier"];
	textVerbosity?: "low" | "medium" | "high";
	toolChoice?: "auto" | "none" | "required";
}
export interface OpenAICompletionsOptions extends StreamOptions {
	toolChoice?: OpenAI.Chat.Completions.ChatCompletionToolChoiceOption;
	reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	thinkingBudgets?: ThinkingBudgets;
}
export interface OpenAIResponsesOptions extends StreamOptions {
	reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
	serviceTier?: ResponseCreateParamsStreaming["service_tier"];
	toolChoice?: ResponseCreateParamsStreaming["tool_choice"];
}
export interface AxiMessagesOptions extends StreamOptions {
	reasoning?: ThinkingLevel;
	toolChoice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
	debug?: boolean;
}
