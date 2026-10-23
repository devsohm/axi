import { type Static, Type } from "typebox";
import { ModelCostSchema } from "./model-schema.ts";

export const SessionAffinityFormatSchema = Type.Union(
	[Type.Literal("openai"), Type.Literal("openai-nosession"), Type.Literal("openrouter")],
	{ description: "Header convention for routing requests from the same session." },
);
export const ThinkingTokenBudgetFieldSchema = Type.Union(
	[Type.Literal("thinking_token_budget"), Type.Literal("thinking_budget"), Type.Literal("thinking_budget_tokens")],
	{
		description:
			"Reasoning-token cap field: thinking_token_budget for vLLM, thinking_budget for Qwen, DashScope or SGLang, and thinking_budget_tokens for llama.cpp.",
	},
);
export const ChatTemplateKwargValueSchema = Type.Union([
	Type.String(),
	Type.Number(),
	Type.Boolean(),
	Type.Null(),
	Type.Object({
		$var: Type.Union([
			Type.Literal("thinking.enabled"),
			Type.Literal("thinking.effort"),
			Type.Literal("thinking.budget"),
		]),
		omitWhenOff: Type.Optional(Type.Boolean()),
	}),
]);
const bool = (description: string, fallback?: boolean) =>
	Type.Optional(Type.Boolean(fallback === undefined ? { description } : { description, default: fallback }));
const strings = (description: string) => Type.Optional(Type.Array(Type.String(), { description }));
const percentile = (metric: string) =>
	Type.Object({
		p50: Type.Optional(Type.Number({ description: `${metric}, measured at percentile 50.` })),
		p75: Type.Optional(Type.Number({ description: `${metric}, measured at percentile 75.` })),
		p90: Type.Optional(Type.Number({ description: `${metric}, measured at percentile 90.` })),
		p99: Type.Optional(Type.Number({ description: `${metric}, measured at percentile 99.` })),
	});
const price = (description: string) => Type.Optional(Type.Union([Type.Number(), Type.String()], { description }));
export const OpenRouterRoutingSchema = Type.Object(
	{
		allow_fallbacks: bool("Allow another provider to handle the request when the preferred provider fails.", true),
		require_parameters: bool("Select only providers that implement every requested parameter.", false),
		data_collection: Type.Optional(
			Type.Union([Type.Literal("deny"), Type.Literal("allow")], {
				description: "Allow providers that retain or train on data, or deny them.",
				default: "allow",
			}),
		),
		zdr: bool("Limit routing to endpoints with zero data retention."),
		enforce_distillable_text: bool("Limit routing to models whose terms allow text distillation."),
		order: strings("Provider names or slugs to attempt in the listed order."),
		only: strings("Allow only these provider names or slugs."),
		ignore: strings("Exclude these provider names or slugs."),
		quantizations: strings("Allowed numeric formats, such as fp16, bf16, fp8 or int4."),
		sort: Type.Optional(
			Type.Union(
				[
					Type.String(),
					Type.Object({
						by: Type.Optional(
							Type.String({ description: "Routing metric, for example price, latency or throughput." }),
						),
						partition: Type.Optional(
							Type.Union([Type.String(), Type.Null()], {
								description: "Group candidates by model, or use none to avoid grouping.",
								default: "model",
							}),
						),
					}),
				],
				{ description: "Routing sort metric as a name or a metric-and-partition object." },
			),
		),
		max_price: Type.Optional(
			Type.Object(
				{
					prompt: price("Maximum USD per million input tokens."),
					completion: price("Maximum USD per million output tokens."),
					image: price("Maximum USD per image."),
					audio: price("Maximum USD per audio unit."),
					request: price("Maximum USD per request."),
				},
				{ description: "Upper price bounds in USD for the listed billing units." },
			),
		),
		preferred_min_throughput: Type.Optional(
			Type.Union([Type.Number(), percentile("Minimum tokens per second")], {
				description: "Preferred token throughput floor; a scalar specifies percentile 50.",
			}),
		),
		preferred_max_latency: Type.Optional(
			Type.Union([Type.Number(), percentile("Maximum latency in seconds")], {
				description: "Preferred latency ceiling in seconds; a scalar specifies percentile 50.",
			}),
		),
	},
	{ description: "OpenRouter upstream selection settings sent in the provider request field." },
);
export const VercelGatewayRoutingSchema = Type.Object(
	{
		only: strings("Allow only these Vercel upstream provider slugs."),
		order: strings("Attempt these Vercel upstream provider slugs in order."),
	},
	{ description: "Upstream provider selection for Vercel AI Gateway." },
);
export const AnthropicAllowedFallbackModelSchema = Type.Object(
	{
		provider: Type.String({ minLength: 1 }),
		model: Type.String({ minLength: 1 }),
		cost: ModelCostSchema,
	},
	{ description: "Permitted Anthropic refusal fallback and its locally recorded prices." },
);
const kwargs = (description: string) =>
	Type.Optional(Type.Record(Type.String(), ChatTemplateKwargValueSchema, { description }));
const affinity = (description: string) => Type.Optional(Type.Union(SessionAffinityFormatSchema.anyOf, { description }));
export const OpenAICompletionsCompatSchema = Type.Object(
	{
		supportsStore: bool("Send the store field when supported; otherwise detect support from the URL."),
		supportsDeveloperRole: bool("Use developer in place of system; otherwise detect support from the URL."),
		supportsReasoningEffort: bool("Send reasoning_effort when supported; otherwise detect support from the URL."),
		supportsUsageInStreaming: bool("Request usage through stream_options.include_usage.", true),
		supportsFinishReason: bool("Expect streamed finish_reason; when false, infer stop or toolUse at stream end.", true),
		maxTokensField: Type.Optional(
			Type.Union([Type.Literal("max_completion_tokens"), Type.Literal("max_tokens")], {
				description: "Request field for the output-token cap; detected from the URL when omitted.",
			}),
		),
		requiresToolResultName: bool("Include a name on tool results; detected from the URL when omitted."),
		requiresAssistantAfterToolResult: bool(
			"Insert an assistant message between tool results and a following user message when required; otherwise detect from the URL.",
		),
		requiresThinkingAsText: bool(
			"Replay reasoning as text enclosed in thinking tags when required; otherwise detect from the URL.",
		),
		requiresReasoningContentOnAssistantMessages: bool(
			"Include empty reasoning_content on replayed assistant messages with reasoning enabled when required; otherwise detect from the URL.",
		),
		thinkingFormat: Type.Optional(
			Type.Union(
				[
					Type.Literal("openai"),
					Type.Literal("openrouter"),
					Type.Literal("deepseek"),
					Type.Literal("together"),
					Type.Literal("baseten"),
					Type.Literal("zai"),
					Type.Literal("qwen"),
					Type.Literal("chat-template"),
					Type.Literal("qwen-chat-template"),
					Type.Literal("string-thinking"),
					Type.Literal("ant-ling"),
				],
				{
					description:
						"Reasoning encoding override, detected from the URL when absent. openai uses reasoning_effort; openrouter uses reasoning.effort; deepseek uses thinking.type; together uses reasoning.enabled; baseten uses configured chat_template_args. DeepSeek, Together and Baseten can also send reasoning_effort when supported. zai uses thinking.type; qwen uses enable_thinking; qwen-chat-template uses chat_template_kwargs.enable_thinking and preserve_thinking; chat-template uses configured chat_template_kwargs; string-thinking uses a top-level thinking value; ant-ling sends reasoning.effort only for a non-null mapped effort.",
				},
			),
		),
		chatTemplateKwargs: kwargs(
			"chat_template_kwargs for chat-template reasoning. Bind $var to thinking.enabled, thinking.effort or thinking.budget.",
		),
		chatTemplateArgs: kwargs(
			"chat_template_args for Baseten reasoning. Bind $var to thinking.enabled, thinking.effort or thinking.budget.",
		),
		openRouterRouting: Type.Optional(OpenRouterRoutingSchema),
		vercelGatewayRouting: Type.Optional(VercelGatewayRoutingSchema),
		zaiToolStream: bool("Send z.ai tool_stream to receive incremental tool arguments.", false),
		thinkingTokenBudgetField: Type.Optional(ThinkingTokenBudgetFieldSchema),
		supportsThinkingTokenBudget: bool(
			"Alias selecting the vLLM thinking_token_budget field; prefer thinkingTokenBudgetField.",
			false,
		),
		supportsOpenAIGrammarTools: bool(
			"Emit Lark or regex custom tools; otherwise use function-tool fallback. Enabled explicitly by capable catalog models.",
			false,
		),
		supportsMidConvoSystemMessages: bool(
			"Accept later system or developer messages; otherwise fold them into the leading message. Enabled explicitly for verified models.",
			false,
		),
		supportsMidConvoToolAdditions: bool(
			"Introduce tools in later system messages. Requires supportsMidConvoSystemMessages.",
			false,
		),
		supportsStrictMode: bool(
			"Accept strict function-tool definitions; capable catalog models enable this explicitly.",
			false,
		),
		cacheControlFormat: Type.Optional(
			Type.Literal("anthropic", {
				description:
					"Use Anthropic cache_control markers on the system prompt, final tool, and final user, assistant or tool-result text.",
			}),
		),
		sendSessionAffinityHeaders: bool(
			"Send session routing data from sessionId. Detected by endpoint, with OpenRouter enabled by default.",
		),
		sessionAffinityFormat: affinity(
			"openai sends session_id, x-client-request-id and x-session-affinity; openai-nosession omits session_id; openrouter sends x-session-id. Does not change prompt_cache_key.",
		),
		supportsLongCacheRetention: bool(
			"Accept 24-hour prompt cache retention or a one-hour Anthropic cache TTL, according to the cache format; otherwise detect support.",
		),
		vllmPriority: Type.Optional(
			Type.Number({
				description:
					"vLLM priority scheduler value. Lower values run first; the server default is zero. Requires priority scheduling and is omitted by default.",
			}),
		),
	},
	{ description: "Completion API compatibility overrides for endpoint-based detection.", additionalProperties: true },
);
export const OpenAIResponsesCompatSchema = Type.Object(
	{
		supportsDeveloperRole: bool("Accept developer-role messages instead of system-role messages.", true),
		supportsMidConvoSystemMessages: bool(
			"Accept later developer or system messages; otherwise fold them into the leading message. Enabled explicitly for verified models.",
			false,
		),
		sessionAffinityFormat: affinity(
			"openai sends session_id and x-client-request-id; openai-nosession sends only x-client-request-id; openrouter sends x-session-id. Does not change prompt_cache_key.",
		),
		supportsLongCacheRetention: bool(
			"Accept long cache retention: a 30-minute prompt_cache_options TTL on GPT-5.6+ or 24-hour prompt_cache_retention on earlier models.",
			true,
		),
		supportsStrictMode: bool(
			"Accept strict JSON-schema function tools; defaults depend on the API and capable catalog models enable support.",
		),
		supportsOpenAIGrammarTools: bool(
			"Emit Lark or regex custom tools; otherwise use function-tool fallback. Enabled explicitly by capable catalog models.",
			false,
		),
		supportsAdditionalTools: bool("Accept message-anchored additional_tools items.", false),
		supportsToolSearch: bool("Accept client-executed tool search for tools added to the transcript.", false),
		supportsExplicitPromptCacheMode: bool("Accept prompt_cache_options; older OpenAI models reject that field.", false),
		supportsMidConvoEffort: bool(
			"Send effort changes as configuration_update items to preserve the cached prefix rather than changing request reasoning.effort.",
			false,
		),
		supportsMaxOutputTokens: bool("Accept max_output_tokens; some gateways using the Codex protocol reject it.", true),
	},
	{ description: "Compatibility overrides for Responses endpoints.", additionalProperties: true },
);
export const AnthropicMessagesCompatSchema = Type.Object(
	{
		supportsEagerToolInputStreaming: bool(
			"Accept eager_input_streaming on tools; otherwise omit it and use the fine-grained-tool-streaming-2025-05-14 beta header for tool requests.",
			true,
		),
		supportsLongCacheRetention: bool("Accept extended Anthropic cache lifetime through cache_control.ttl.", true),
		sendSessionAffinityHeaders: bool(
			"Send session routing headers while caching. Fireworks uses affinity to route related prompts to the same replica; OpenRouter endpoints enable it by default.",
		),
		sessionAffinityFormat: Type.Optional(
			Type.Literal("openrouter", {
				description: "Use x-session-id for OpenRouter; when absent, use x-session-affinity.",
			}),
		),
		supportsCacheControlOnTools: bool(
			"Allow cache_control on tool definitions. Disable for endpoints such as Fireworks that reject or ignore it.",
			true,
		),
		supportsTemperature: bool(
			"Accept the temperature request field. Claude Opus 4.7 and newer reject non-default values.",
			true,
		),
		forceAdaptiveThinking: bool(
			"Require adaptive thinking and output_config.effort independently of model ID. Catalog entries can enable this; false disables that override.",
			false,
		),
		allowEmptySignature: bool("Replay empty reasoning signatures rather than converting the reasoning to text.", false),
		supportsStrictTools: bool(
			"Accept Anthropic strict tool schemas; capable catalog models enable this explicitly.",
			false,
		),
		supportsMidConvoEffort: bool(
			"Accept effort-only system updates and reasoning binding controls on this model transport.",
			false,
		),
		supportsMidConvoSystemMessages: bool(
			"Accept system messages during a conversation; otherwise combine later system text with the initial prompt.",
			false,
		),
		supportsMidConvoToolChanges: bool(
			"Accept tool_addition and tool_removal during the conversation. Requires supportsMidConvoSystemMessages.",
			false,
		),
		allowedFallbackModels: Type.Optional(
			Type.Array(AnthropicAllowedFallbackModelSchema, {
				maxItems: 3,
				description:
					"Permitted refusal fallback targets and their local prices. Omit fallbacks when this list is absent or empty because unsupported targets are rejected.",
			}),
		),
	},
	{ description: "Compatibility overrides for Anthropic Messages endpoints.", additionalProperties: true },
);
export const BedrockCompatSchema = Type.Object(
	{ supportsStrictMode: bool("Accept Bedrock strict tool schemas.", false) },
	{ description: "Compatibility overrides for Amazon Bedrock models.", additionalProperties: true },
);
export const MistralConversationsCompatSchema = Type.Object(
	{
		supportsMidConvoSystemMessages: bool(
			"Accept system messages after the conversation starts; otherwise combine them with the initial system message.",
			false,
		),
	},
	{ description: "Compatibility overrides for Mistral conversation models.", additionalProperties: true },
);
export const SystemOneCompatSchema = Type.Object(
	{
		imageInput: Type.Optional(
			Type.Union([Type.Literal("assets"), Type.Literal("images"), Type.Literal("state-image-urls")], {
				description: "Classifier image encoding. Omitted values are detected from the endpoint and model.",
			}),
		),
		sendImageOptInHeader: bool("Send the TypeSafe image opt-in header for requests containing images."),
	},
	{ description: "System One classifier compatibility settings.", additionalProperties: true },
);
export const CompatSchemasByApi = {
	"openai-completions": OpenAICompletionsCompatSchema,
	"openai-responses": OpenAIResponsesCompatSchema,
	"azure-openai-responses": OpenAIResponsesCompatSchema,
	"openai-codex-responses": OpenAIResponsesCompatSchema,
	"anthropic-messages": AnthropicMessagesCompatSchema,
	"bedrock-converse-stream": BedrockCompatSchema,
	"mistral-conversations": MistralConversationsCompatSchema,
	"typesafe-system-one": SystemOneCompatSchema,
	"cloudflare-workers-ai-system-one": SystemOneCompatSchema,
} as const;
export const ProviderCompatSchema = Type.Object(
	{
		...OpenAICompletionsCompatSchema.properties,
		...OpenAIResponsesCompatSchema.properties,
		...AnthropicMessagesCompatSchema.properties,
		...BedrockCompatSchema.properties,
		...MistralConversationsCompatSchema.properties,
		...SystemOneCompatSchema.properties,
		supportsDeveloperRole: bool(
			"Accept developer-role messages instead of system-role messages; defaults depend on the API.",
		),
		supportsMidConvoSystemMessages: bool(
			"Accept later system or developer messages; otherwise combine them with the leading system message.",
			false,
		),
		sessionAffinityFormat: affinity(
			"Session routing header convention; defaults depend on the API or endpoint detection.",
		),
		supportsMidConvoEffort: bool(
			"Record effort changes inside the conversation to preserve the cached prefix on Anthropic Messages or Responses transports.",
			false,
		),
		supportsLongCacheRetention: bool(
			"Accept extended prompt cache lifetime; defaults depend on the API or endpoint detection.",
		),
		supportsStrictMode: bool("Accept strict tool schemas; defaults depend on the API."),
		supportsOpenAIGrammarTools: bool("Emit Lark or regex custom tools; otherwise use function-tool fallback.", false),
		sendSessionAffinityHeaders: bool("Send session routing data from sessionId; defaults depend on the API."),
	},
	{ description: "Provider-wide and model-specific compatibility settings.", additionalProperties: true },
);
export type ChatTemplateKwargValue = Static<typeof ChatTemplateKwargValueSchema>;
export type ThinkingTokenBudgetField = Static<typeof ThinkingTokenBudgetFieldSchema>;
export type SessionAffinityFormat = Static<typeof SessionAffinityFormatSchema>;
export interface OpenRouterRouting extends Static<typeof OpenRouterRoutingSchema> {}
export interface VercelGatewayRouting extends Static<typeof VercelGatewayRoutingSchema> {}
export interface AnthropicAllowedFallbackModel extends Static<typeof AnthropicAllowedFallbackModelSchema> {}
export interface OpenAICompletionsCompat extends Static<typeof OpenAICompletionsCompatSchema> {}
export interface OpenAIResponsesCompat extends Static<typeof OpenAIResponsesCompatSchema> {}
export interface AnthropicMessagesCompat extends Static<typeof AnthropicMessagesCompatSchema> {}
export interface BedrockCompat extends Static<typeof BedrockCompatSchema> {}
export interface MistralConversationsCompat extends Static<typeof MistralConversationsCompatSchema> {}
export interface SystemOneCompat extends Static<typeof SystemOneCompatSchema> {}
