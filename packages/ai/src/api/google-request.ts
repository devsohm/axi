import type { GenerateContentConfig, GenerateContentParameters } from "@google/genai";
import { clampThinkingLevel } from "../models.ts";
import type { Model, SimpleStreamOptions, TranscriptContext } from "../types.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { getSystemMessageText } from "../utils/text.ts";
import { getCurrentTools, getInitialSystemMessage } from "../utils/transcript.ts";
import {
	convertMessages,
	convertTools,
	getDisabledGoogleThinkingConfig,
	resolveGoogleFunctionCallingMode,
	resolveGoogleThinkingLevel,
	supportsGoogleStrictToolSampling,
	toGoogleSdkThinkingLevel,
	toGoogleThinkingLevel,
	usesGoogleThinkingLevel,
} from "./google-shared.ts";
import type { GoogleOptions } from "./options.ts";
import { buildBaseOptions } from "./simple-options.ts";
type GoogleModel = Model<"google-generative-ai" | "google-vertex">;
export function googleRequest(
	model: GoogleModel,
	context: TranscriptContext,
	options: GoogleOptions,
): GenerateContentParameters {
	const tools = getCurrentTools(context.messages),
		system = getInitialSystemMessage(context.messages);
	const strict = supportsGoogleStrictToolSampling(model.id);
	const mode = tools.length ? resolveGoogleFunctionCallingMode(tools, options.toolChoice, strict) : undefined;
	const systemText = system ? getSystemMessageText(system) : "";
	const config: GenerateContentConfig = {
		...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
		...(options.maxTokens !== undefined ? { maxOutputTokens: options.maxTokens } : {}),
		...(systemText ? { systemInstruction: sanitizeSurrogates(systemText) } : {}),
		...(tools.length ? { tools: convertTools(tools, false, strict) } : {}),
		...(mode !== undefined ? { toolConfig: { functionCallingConfig: { mode } } } : {}),
	};
	if (model.reasoning && options.thinking) {
		config.thinkingConfig = options.thinking.enabled
			? {
					includeThoughts: true,
					...(options.thinking.level !== undefined
						? { thinkingLevel: toGoogleSdkThinkingLevel(options.thinking.level) }
						: options.thinking.budgetTokens !== undefined
							? { thinkingBudget: options.thinking.budgetTokens }
							: {}),
				}
			: getDisabledGoogleThinkingConfig(model);
	}
	if (options.signal) {
		if (options.signal.aborted) throw new Error("Request aborted");
		config.abortSignal = options.signal;
	}
	return { model: model.id, contents: convertMessages(model, context), config };
}
export function googleSimpleOptions(
	model: GoogleModel,
	context: TranscriptContext,
	options: SimpleStreamOptions,
): GoogleOptions {
	const base = { ...buildBaseOptions(model, context, options, options.apiKey), toolChoice: options.toolChoice };
	const level = options.reasoning ? clampThinkingLevel(model, options.reasoning) : "off";
	if (level === "off") return { ...base, thinking: { enabled: false } };
	const resolved = resolveGoogleThinkingLevel(model, level);
	if (usesGoogleThinkingLevel(model))
		return { ...base, thinking: { enabled: true, level: toGoogleThinkingLevel(resolved) } };
	const pro = model.id.includes("2.5-pro"),
		flash = model.id.includes("2.5-flash");
	const lite = model.api === "google-generative-ai" && model.id.includes("2.5-flash-lite");
	const budget =
		options.thinkingBudgets?.[resolved] ??
		(pro || flash
			? { minimal: !pro && lite ? 512 : 128, low: 2048, medium: 8192, high: pro ? 32768 : 24576 }[resolved]
			: -1);
	return { ...base, thinking: { enabled: true, budgetTokens: budget } };
}
