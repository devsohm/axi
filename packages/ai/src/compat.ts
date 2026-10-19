export * from "./index.ts";
export * from "./env-api-keys.ts";
export * from "./image-models.ts";
export * from "./images.ts";
export * from "./images-api-registry.ts";
export * from "./providers/images/register-builtins.ts";
export * from "./legacy-api-aliases.ts";
export * from "./api/anthropic-messages.lazy.ts";
export * from "./api/azure-openai-responses.lazy.ts";
export * from "./api/bedrock-converse-stream.lazy.ts";
export * from "./api/google-generative-ai.lazy.ts";
export * from "./api/google-vertex.lazy.ts";
export * from "./api/mistral-conversations.lazy.ts";
export * from "./api/openai-codex-responses.lazy.ts";
export * from "./api/openai-completions.lazy.ts";
export * from "./api/openai-responses.lazy.ts";
export * from "./api/axi-messages.lazy.ts";

import { anthropicMessagesApi } from "./api/anthropic-messages.lazy.ts";
import { azureOpenAIResponsesApi } from "./api/azure-openai-responses.lazy.ts";
import { bedrockConverseStreamApi } from "./api/bedrock-converse-stream.lazy.ts";
import { googleGenerativeAIApi } from "./api/google-generative-ai.lazy.ts";
import { googleVertexApi } from "./api/google-vertex.lazy.ts";
import { mistralConversationsApi } from "./api/mistral-conversations.lazy.ts";
import { openAICodexResponsesApi } from "./api/openai-codex-responses.lazy.ts";
import { openAICompletionsApi } from "./api/openai-completions.lazy.ts";
import { openAIResponsesApi } from "./api/openai-responses.lazy.ts";
import { axiMessagesApi } from "./api/axi-messages.lazy.ts";
import { getEnvApiKey } from "./env-api-keys.ts";
import type { ModelsApiStreamOptions } from "./models.ts";
import { builtinModels, getBuiltinModel, getBuiltinModels, getBuiltinProviders } from "./providers/all.ts";
import { createFauxCore, type FauxProviderRegistration, type RegisterFauxProviderOptions } from "./providers/faux.ts";
import type {
	Api,
	ApiStreamOptions,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	ProviderStreamOptions,
	ProviderStreams,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	TranscriptContext,
} from "./types.ts";
import { normalizeContext } from "./utils/transcript.ts";
export type { BuiltinProvider } from "./providers/all.ts";
export const getModel = getBuiltinModel,
	getModels = getBuiltinModels,
	getProviders = getBuiltinProviders;
export type ApiStreamFunction = (
	model: Model<Api>,
	context: TranscriptContext,
	options?: StreamOptions,
) => AssistantMessageEventStream;
export type ApiStreamSimpleFunction = (
	model: Model<Api>,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;
export interface ApiProvider<A extends Api = Api, O extends StreamOptions = StreamOptions> {
	api: A;
	stream: StreamFunction<A, O>;
	streamSimple: StreamFunction<A, SimpleStreamOptions>;
}
interface RegisteredApi {
	api: Api;
	stream: ApiStreamFunction;
	streamSimple: ApiStreamSimpleFunction;
}
const registry = new Map<Api, { provider: RegisteredApi; sourceId?: string }>();
export function registerApiProvider<A extends Api, O extends StreamOptions>(
	provider: ApiProvider<A, O>,
	sourceId?: string,
): void {
	const { api, stream, streamSimple } = provider;
	const check = (model: Model<Api>) => {
		if (model.api !== api) throw new Error(`Mismatched api: ${model.api} expected ${api}`);
	};
	registry.set(api, {
		sourceId,
		provider: {
			api,
			stream: (model, context, options) => {
				check(model);
				return stream(model as Model<A>, context, options as O);
			},
			streamSimple: (model, context, options) => {
				check(model);
				return streamSimple(model as Model<A>, context, options);
			},
		},
	});
}
export function getApiProvider(api: Api): RegisteredApi | undefined {
	return registry.get(api)?.provider;
}
export function getApiProviders(): RegisteredApi[] {
	return [...registry.values()].map((entry) => entry.provider);
}
export function unregisterApiProviders(sourceId: string): void {
	for (const [api, entry] of registry) if (entry.sourceId === sourceId) registry.delete(api);
}
const builtins: [Api, ProviderStreams][] = [
	["anthropic-messages", anthropicMessagesApi()],
	["openai-completions", openAICompletionsApi()],
	["openai-responses", openAIResponsesApi()],
	["openai-codex-responses", openAICodexResponsesApi()],
	["azure-openai-responses", azureOpenAIResponsesApi()],
	["google-generative-ai", googleGenerativeAIApi()],
	["google-vertex", googleVertexApi()],
	["mistral-conversations", mistralConversationsApi()],
	["bedrock-converse-stream", bedrockConverseStreamApi()],
	["axi-messages", axiMessagesApi()],
];
const installed = new Map<Api, RegisteredApi | undefined>();
export function registerBuiltInApiProviders(): void {
	for (const [api, streams] of builtins) {
		if (!registry.has(api)) registerApiProvider({ api, stream: streams.stream, streamSimple: streams.streamSimple });
		installed.set(api, getApiProvider(api));
	}
}
export function resetApiProviders(): void {
	registry.clear();
	installed.clear();
	registerBuiltInApiProviders();
}
registerBuiltInApiProviders();
const models = builtinModels();
const present = (value: string | undefined) => typeof value === "string" && !!value.trim();
function auth<O extends StreamOptions>(model: Model<Api>, options: O | undefined): O | undefined {
	if (present(options?.apiKey)) return options;
	const key = getEnvApiKey(model.provider, options?.env);
	return key && key !== "<authenticated>" ? ({ ...options, apiKey: key } as O) : options;
}
function builtin(model: Model<Api>) {
	if (getApiProvider(model.api) !== installed.get(model.api)) return undefined;
	const provider = models.getProvider(model.provider);
	return provider?.getModels().some((entry) => entry.api === model.api) ? provider : undefined;
}
function cloudflare(model: Model<Api>, options: StreamOptions | undefined): boolean {
	return (
		model.provider.startsWith("cloudflare-") &&
		!present(options?.apiKey) &&
		typeof options?.headers?.["cf-aig-authorization"] !== "string"
	);
}
function resolve(api: Api): RegisteredApi {
	const provider = getApiProvider(api);
	if (!provider) throw new Error(`No API provider registered for api: ${api}`);
	return provider;
}
export function stream<A extends Api>(
	model: Model<A>,
	context: Context,
	options?: ProviderStreamOptions,
): AssistantMessageEventStream {
	const transcript = normalizeContext(context),
		provider = builtin(model);
	if (provider)
		return cloudflare(model, options)
			? models.stream(model, transcript, options as ModelsApiStreamOptions<A>)
			: provider.stream(model, transcript, auth(model, options) as ApiStreamOptions<A>);
	return resolve(model.api).stream(model, transcript, auth(model, options));
}
export function streamSimple<A extends Api>(
	model: Model<A>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const transcript = normalizeContext(context),
		provider = builtin(model);
	if (provider)
		return cloudflare(model, options)
			? models.streamSimple(model, transcript, options)
			: provider.streamSimple(model, transcript, auth(model, options));
	return resolve(model.api).streamSimple(model, transcript, auth(model, options));
}
export async function complete<A extends Api>(
	model: Model<A>,
	context: Context,
	options?: ProviderStreamOptions,
): Promise<AssistantMessage> {
	return stream(model, context, options).result();
}
export async function completeSimple<A extends Api>(
	model: Model<A>,
	context: Context,
	options?: SimpleStreamOptions,
): Promise<AssistantMessage> {
	return streamSimple(model, context, options).result();
}
export function registerFauxProvider(options: RegisterFauxProviderOptions = {}): FauxProviderRegistration {
	const core = createFauxCore(options),
		id = `axi-faux-${Math.random().toString(36).slice(2, 10)}`;
	registerApiProvider({ api: core.api, stream: core.stream, streamSimple: core.streamSimple }, id);
	return {
		api: core.api,
		models: core.models,
		getModel: core.getModel,
		state: core.state,
		setResponses: core.setResponses,
		appendResponses: core.appendResponses,
		getPendingResponseCount: core.getPendingResponseCount,
		unregister: () => unregisterApiProviders(id),
	};
}
