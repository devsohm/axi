import {
	type Content,
	type FinishReason,
	FunctionCallingConfigMode,
	type Part,
	ThinkingLevel as SdkLevel,
	type ThinkingConfig,
} from "@google/genai";
import { clampThinkingLevel } from "../models.ts";
import type { Model, StopReason, StreamOptions, ThinkingLevel, Tool, TranscriptContext } from "../types.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { collapseSystemMessages, withoutInitialSystemMessage } from "../utils/transcript.ts";
import { getJsonSchemaToolParameters, resolveJsonSchemaStrictSampling } from "./constrained-sampling.ts";
import { transformMessages } from "./transform-messages.ts";
export type { GoogleApiThinkingLevel, ResolvedGoogleThinkingLevel } from "./options.ts";
import type { GoogleApiThinkingLevel, ResolvedGoogleThinkingLevel } from "./options.ts";

type GoogleApi = "google-generative-ai" | "google-vertex";
export function resolveGoogleThinkingLevel<T extends GoogleApi>(
	model: Model<T>,
	level: ThinkingLevel,
): ResolvedGoogleThinkingLevel {
	const mapped = model.thinkingLevelMap?.[level];
	const resolved = typeof mapped === "string" ? mapped.toLowerCase() : level;
	if (resolved === "minimal" || resolved === "low" || resolved === "medium" || resolved === "high") return resolved;
	throw new Error(
		`Unsupported Google thinking level mapping for ${model.provider}/${model.id}: ${level} -> ${String(mapped)}`,
	);
}
export function usesGoogleThinkingLevel<T extends GoogleApi>(model: Model<T>): boolean {
	const id = model.id.toLowerCase();
	return (
		/gemini-3(?:\.\d+)?-(?:pro|flash)|gemini-(?:[4-9]|[1-9]\d)|gemma-?4/.test(id) ||
		id === "gemini-flash-latest" ||
		id === "gemini-flash-lite-latest"
	);
}
export function toGoogleThinkingLevel(level: ResolvedGoogleThinkingLevel): GoogleApiThinkingLevel {
	const levels = { minimal: "MINIMAL", low: "LOW", medium: "MEDIUM", high: "HIGH" } as const;
	return levels[level];
}
export function toGoogleSdkThinkingLevel(level: GoogleApiThinkingLevel): SdkLevel {
	return SdkLevel[level];
}
export function getDisabledGoogleThinkingConfig<T extends GoogleApi>(model: Model<T>): ThinkingConfig {
	const lowest = usesGoogleThinkingLevel(model) ? clampThinkingLevel(model, "off") : "off";
	return lowest === "off"
		? { thinkingBudget: 0 }
		: { thinkingLevel: toGoogleSdkThinkingLevel(toGoogleThinkingLevel(resolveGoogleThinkingLevel(model, lowest))) };
}
export function isThinkingPart(part: Pick<Part, "thought" | "thoughtSignature">): boolean {
	return part.thought === true;
}
export function retainThoughtSignature(existing: string | undefined, incoming: string | undefined): string | undefined {
	return typeof incoming === "string" && incoming.length > 0 ? incoming : existing;
}
function geminiVersion(id: string): number | undefined {
	const match = /^gemini(?:-live)?-(\d+)/i.exec(id);
	return match ? Number.parseInt(match[1], 10) : undefined;
}
export function requiresToolCallId(modelId: string): boolean {
	return modelId.startsWith("claude-") || modelId.startsWith("gpt-oss-") || (geminiVersion(modelId) ?? 0) >= 3;
}
export function convertMessages<T extends GoogleApi>(model: Model<T>, context: TranscriptContext): Content[] {
	const includeIds = requiresToolCallId(model.id);
	const messages = transformMessages(
		withoutInitialSystemMessage(collapseSystemMessages(context).messages),
		model,
		(id) => (includeIds ? id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) : id),
	);
	const result: Content[] = [];
	const imagePart = (image: { mimeType: string; data: string }): Part => ({
		inlineData: { mimeType: image.mimeType, data: image.data },
	});
	for (const message of messages) {
		if (message.role === "user") {
			const parts =
				typeof message.content === "string"
					? [{ text: sanitizeSurrogates(message.content) }]
					: message.content.map((block) =>
							block.type === "text" ? { text: sanitizeSurrogates(block.text) } : imagePart(block),
						);
			if (parts.length) result.push({ role: "user", parts });
		} else if (message.role === "assistant") {
			const same = message.provider === model.provider && message.model === model.id;
			const signature = (value?: string): string | undefined =>
				same && value && value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value) ? value : undefined;
			const parts: Part[] = [];
			for (const block of message.content) {
				if (block.type === "toolCall") {
					const thoughtSignature = signature(block.thoughtSignature);
					parts.push({
						functionCall: { name: block.name, args: block.arguments ?? {}, ...(includeIds ? { id: block.id } : {}) },
						...(thoughtSignature ? { thoughtSignature } : {}),
					});
				} else {
					const text = block.type === "text" ? block.text : block.thinking;
					const thoughtSignature = signature(block.type === "text" ? block.textSignature : block.thinkingSignature);
					if (!text.trim() && !thoughtSignature) continue;
					parts.push({
						text: sanitizeSurrogates(text),
						...(block.type === "thinking" && same ? { thought: true } : {}),
						...(thoughtSignature ? { thoughtSignature } : {}),
					});
				}
			}
			if (parts.length) result.push({ role: "model", parts });
		} else if (message.role === "toolResult") {
			const text = message.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("\n");
			const images = model.input.includes("image")
				? message.content.filter((block) => block.type === "image").map(imagePart)
				: [];
			const nestedImages = (geminiVersion(model.id) ?? 3) >= 3;
			const value = text.trim() ? sanitizeSurrogates(text) : images.length ? "(see attached image)" : "";
			const response: Part = {
				functionResponse: {
					name: message.toolName,
					response: message.isError ? { error: value } : { output: value },
					...(includeIds ? { id: message.toolCallId } : {}),
					...(images.length && nestedImages ? { parts: images } : {}),
				},
			};
			const last = result.at(-1);
			if (last?.role === "user" && last.parts?.some((part) => part.functionResponse)) last.parts.push(response);
			else result.push({ role: "user", parts: [response] });
			if (images.length && !nestedImages)
				result.push({ role: "user", parts: [{ text: "Tool result image:" }, ...images] });
		}
	}
	return result;
}
const schemaMetadata = new Set([
	"$schema",
	"$id",
	"$anchor",
	"$dynamicAnchor",
	"$vocabulary",
	"$comment",
	"$defs",
	"definitions",
]);
function openApiSchema(value: unknown): unknown {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
	const result: Record<string, unknown> = {};
	for (const [key, nested] of Object.entries(value)) if (!schemaMetadata.has(key)) result[key] = openApiSchema(nested);
	return result;
}
export function convertTools(
	tools: Tool[],
	useParameters = false,
	supportsStrictMode = true,
): { functionDeclarations: Record<string, unknown>[] }[] | undefined {
	if (!tools.length) return undefined;
	return [
		{
			functionDeclarations: tools.map((tool) => {
				const parameters = getJsonSchemaToolParameters(tool, resolveJsonSchemaStrictSampling(tool, supportsStrictMode));
				return {
					name: tool.name,
					description: tool.description,
					...(useParameters ? { parameters: openApiSchema(parameters) } : { parametersJsonSchema: parameters }),
				};
			}),
		},
	];
}
export function supportsGoogleStrictToolSampling(modelId: string): boolean {
	return (geminiVersion(modelId) ?? 0) >= 3;
}
export function mapToolChoice(choice: string): FunctionCallingConfigMode {
	return choice === "none"
		? FunctionCallingConfigMode.NONE
		: choice === "any"
			? FunctionCallingConfigMode.ANY
			: FunctionCallingConfigMode.AUTO;
}
export function resolveGoogleFunctionCallingMode(
	tools: Tool[],
	toolChoice: string | undefined,
	supportsStrictMode: boolean,
): FunctionCallingConfigMode | undefined {
	const strict = tools.some((tool) => resolveJsonSchemaStrictSampling(tool, supportsStrictMode) === true);
	return toolChoice === "none" || toolChoice === "any"
		? mapToolChoice(toolChoice)
		: strict
			? FunctionCallingConfigMode.VALIDATED
			: toolChoice
				? mapToolChoice(toolChoice)
				: undefined;
}
export function mapStopReason(reason: FinishReason): StopReason {
	switch (reason) {
		case "STOP":
			return "stop";
		case "MAX_TOKENS":
			return "length";
		case "BLOCKLIST":
		case "PROHIBITED_CONTENT":
		case "SPII":
		case "SAFETY":
		case "IMAGE_SAFETY":
		case "IMAGE_PROHIBITED_CONTENT":
		case "IMAGE_RECITATION":
		case "IMAGE_OTHER":
		case "RECITATION":
		case "FINISH_REASON_UNSPECIFIED":
		case "OTHER":
		case "LANGUAGE":
		case "MALFORMED_FUNCTION_CALL":
		case "UNEXPECTED_TOOL_CALL":
		case "TOO_MANY_TOOL_CALLS":
		case "NO_IMAGE":
			return "error";
		default: {
			const unhandled: never = reason;
			throw new Error(`Unhandled stop reason: ${unhandled}`);
		}
	}
}
export function mapStopReasonString(reason: string): StopReason {
	return reason === "STOP" ? "stop" : reason === "MAX_TOKENS" ? "length" : "error";
}
export function retryGoogleRequest<T>(
	request: () => Promise<T>,
	options?: Pick<StreamOptions, "maxRetries" | "maxRetryDelayMs" | "signal">,
): Promise<T> {
	return retryProviderRequest(
		async () => {
			try {
				return await request();
			} catch (error) {
				if (error instanceof Error && "status" in error && !("headers" in error))
					Object.assign(error, { headers: undefined });
				throw error;
			}
		},
		{ maxRetries: options?.maxRetries, maxRetryDelayMs: options?.maxRetryDelayMs, signal: options?.signal },
	);
}
