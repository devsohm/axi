import type { StreamFunction, SimpleStreamOptions } from "./types.ts";
import type {
	AnthropicOptions,
	AzureOpenAIResponsesOptions,
	GoogleOptions,
	GoogleVertexOptions,
	MistralOptions,
	OpenAICodexResponsesOptions,
	OpenAICompletionsOptions,
	OpenAIResponsesOptions,
} from "./api/options.ts";
import { anthropicMessagesApi } from "./api/anthropic-messages.lazy.ts";
import { azureOpenAIResponsesApi } from "./api/azure-openai-responses.lazy.ts";
import { googleGenerativeAIApi } from "./api/google-generative-ai.lazy.ts";
import { googleVertexApi } from "./api/google-vertex.lazy.ts";
import { mistralConversationsApi } from "./api/mistral-conversations.lazy.ts";
import { openAICodexResponsesApi } from "./api/openai-codex-responses.lazy.ts";
import { openAICompletionsApi } from "./api/openai-completions.lazy.ts";
import { openAIResponsesApi } from "./api/openai-responses.lazy.ts";
const anthropicMessages = anthropicMessagesApi();
export const streamAnthropic: StreamFunction<"anthropic-messages", AnthropicOptions> = anthropicMessages.stream;
export const streamSimpleAnthropic: StreamFunction<"anthropic-messages", SimpleStreamOptions> =
	anthropicMessages.streamSimple;
const azureOpenAIResponses = azureOpenAIResponsesApi();
export const streamAzureOpenAIResponses: StreamFunction<"azure-openai-responses", AzureOpenAIResponsesOptions> =
	azureOpenAIResponses.stream;
export const streamSimpleAzureOpenAIResponses: StreamFunction<"azure-openai-responses", SimpleStreamOptions> =
	azureOpenAIResponses.streamSimple;
const googleGenerativeAI = googleGenerativeAIApi();
export const streamGoogle: StreamFunction<"google-generative-ai", GoogleOptions> = googleGenerativeAI.stream;
export const streamSimpleGoogle: StreamFunction<"google-generative-ai", SimpleStreamOptions> =
	googleGenerativeAI.streamSimple;
const googleVertex = googleVertexApi();
export const streamGoogleVertex: StreamFunction<"google-vertex", GoogleVertexOptions> = googleVertex.stream;
export const streamSimpleGoogleVertex: StreamFunction<"google-vertex", SimpleStreamOptions> = googleVertex.streamSimple;
const mistralConversations = mistralConversationsApi();
export const streamMistral: StreamFunction<"mistral-conversations", MistralOptions> = mistralConversations.stream;
export const streamSimpleMistral: StreamFunction<"mistral-conversations", SimpleStreamOptions> =
	mistralConversations.streamSimple;
const openAICodexResponses = openAICodexResponsesApi();
export const streamOpenAICodexResponses: StreamFunction<"openai-codex-responses", OpenAICodexResponsesOptions> =
	openAICodexResponses.stream;
export const streamSimpleOpenAICodexResponses: StreamFunction<"openai-codex-responses", SimpleStreamOptions> =
	openAICodexResponses.streamSimple;
const openAICompletions = openAICompletionsApi();
export const streamOpenAICompletions: StreamFunction<"openai-completions", OpenAICompletionsOptions> =
	openAICompletions.stream;
export const streamSimpleOpenAICompletions: StreamFunction<"openai-completions", SimpleStreamOptions> =
	openAICompletions.streamSimple;
const openAIResponses = openAIResponsesApi();
export const streamOpenAIResponses: StreamFunction<"openai-responses", OpenAIResponsesOptions> = openAIResponses.stream;
export const streamSimpleOpenAIResponses: StreamFunction<"openai-responses", SimpleStreamOptions> =
	openAIResponses.streamSimple;
