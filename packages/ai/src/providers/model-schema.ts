import { type Static, Type } from "typebox";

export const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const MODEL_THINKING_LEVELS = ["off", ...THINKING_LEVELS] as const;
export const MODEL_INPUT_MODALITIES = ["text", "image"] as const;
export const CACHE_RETENTIONS = ["none", "short", "long"] as const;
export const MODEL_PROMPT_CACHE_RETENTIONS = ["short", "long"] as const;
export const ThinkingLevelSchema = Type.Enum(THINKING_LEVELS);
export const ModelThinkingLevelSchema = Type.Enum(MODEL_THINKING_LEVELS);
export const ModelInputModalitySchema = Type.Enum(MODEL_INPUT_MODALITIES);
export const CacheRetentionSchema = Type.Enum(CACHE_RETENTIONS);
export const ThinkingLevelMapSchema = Type.Partial(
	Type.Record(ModelThinkingLevelSchema, Type.Union([Type.String(), Type.Null()])),
	{
		description:
			"Provider values for thinking levels. null disables a level. Missing levels use provider defaults through high; xhigh and max require an explicit value.",
	},
);
export const ModelPromptCacheSchema = Type.Partial(
	Type.Record(Type.Enum(MODEL_PROMPT_CACHE_RETENTIONS), Type.Number({ exclusiveMinimum: 0 })),
	{ description: "Estimated cache lifetimes in seconds. Only retention tiers with a known lifetime can be warmed." },
);
const rates = {
	input: Type.Number({ description: "USD per million input tokens." }),
	output: Type.Number({ description: "USD per million output tokens." }),
	cacheRead: Type.Number({ description: "USD per million tokens read from cache." }),
	cacheWrite: Type.Number({ description: "USD per million tokens written to cache." }),
};
export const ModelCostRatesSchema = Type.Object(rates);
export const ModelCostTierSchema = Type.Object({
	inputTokensAbove: Type.Number({ description: "Apply these rates when total request input exceeds this threshold." }),
	...rates,
});
export const ModelCostSchema = Type.Object({
	...rates,
	tiers: Type.Optional(
		Type.Array(ModelCostTierSchema, {
			description: "The highest matching input threshold selects rates for the whole request.",
		}),
	),
});
export const ModelImageResizeOptionsSchema = Type.Object({
	maxWidth: Type.Optional(Type.Integer({ minimum: 1 })),
	maxHeight: Type.Optional(Type.Integer({ minimum: 1 })),
	maxBytes: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum byte size after base64 encoding." })),
	jpegQuality: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});
export const ModelImageInputLimitsSchema = Type.Object({
	resize: Type.Optional(
		Type.Object(ModelImageResizeOptionsSchema.properties, {
			description: "Resize new images before adding them to history so later requests can reuse the same cache prefix.",
		}),
	),
	maxPerMessage: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum images in one provider message." })),
	maxPerRequest: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum images in one provider request." })),
});
export const ModelInputLimitsSchema = Type.Object({
	maxRequestBytes: Type.Optional(
		Type.Integer({ minimum: 1, description: "Maximum byte size of the serialized provider request." }),
	),
	images: Type.Optional(ModelImageInputLimitsSchema),
});
export type ThinkingLevel = Static<typeof ThinkingLevelSchema>;
export type ModelThinkingLevel = Static<typeof ModelThinkingLevelSchema>;
export type ThinkingLevelMap = Static<typeof ThinkingLevelMapSchema>;
export type ModelInputModality = Static<typeof ModelInputModalitySchema>;
export type CacheRetention = Static<typeof CacheRetentionSchema>;
export type ModelPromptCache = Static<typeof ModelPromptCacheSchema>;
export type ModelCostRates = Static<typeof ModelCostRatesSchema>;
export type ModelCostTier = Static<typeof ModelCostTierSchema>;
export type ModelCost = Static<typeof ModelCostSchema>;
export type ModelImageResizeOptions = Static<typeof ModelImageResizeOptionsSchema>;
export type ModelImageInputLimits = Static<typeof ModelImageInputLimitsSchema>;
export type ModelInputLimits = Static<typeof ModelInputLimitsSchema>;
