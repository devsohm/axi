import { createProvider, type Provider } from "../models.ts";
import type {
	AssistantMessage,
	AssistantMessageEventStream,
	DeferredCancelOptions,
	DeferredFetchOptions,
	DeferredHandle,
	ImageContent,
	Message,
	Model,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	ToolCall,
	TranscriptContext,
	Usage,
} from "../types.ts";
import { createAssistantMessageEventStream } from "../utils/event-stream.ts";
import { getSystemMessageText } from "../utils/text.ts";

const emptyUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const identifier = (prefix: string) => `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
export interface FauxModelDefinition {
	id: string;
	name?: string;
	reasoning?: boolean;
	input?: ("text" | "image")[];
	inputLimits?: Model<string>["inputLimits"];
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow?: number;
	maxTokens?: number;
}
export type FauxContentBlock = TextContent | ThinkingContent | ToolCall;
export function fauxText(text: string): TextContent {
	return { type: "text", text };
}
export function fauxThinking(thinking: string): ThinkingContent {
	return { type: "thinking", thinking };
}
export function fauxToolCall(name: string, arguments_: ToolCall["arguments"], options: { id?: string } = {}): ToolCall {
	return { type: "toolCall", id: options.id ?? identifier("tool"), name, arguments: arguments_ };
}
export function fauxAssistantMessage(
	content: string | FauxContentBlock | FauxContentBlock[],
	options: {
		stopReason?: AssistantMessage["stopReason"];
		deferred?: DeferredHandle;
		errorMessage?: string;
		responseId?: string;
		timestamp?: number;
	} = {},
): AssistantMessage {
	return {
		role: "assistant",
		content: typeof content === "string" ? [fauxText(content)] : Array.isArray(content) ? content : [content],
		api: "faux",
		provider: "faux",
		model: "faux-1",
		usage: emptyUsage,
		stopReason: options.stopReason ?? "stop",
		...(options.deferred === undefined ? {} : { deferred: options.deferred }),
		...(options.errorMessage === undefined ? {} : { errorMessage: options.errorMessage }),
		...(options.responseId === undefined ? {} : { responseId: options.responseId }),
		timestamp: options.timestamp ?? Date.now(),
	};
}
export interface FauxProviderState {
	callCount: number;
	deferredFetchCount: number;
	cancelledDeferred: DeferredHandle[];
}
export type FauxResponseFactory = (
	context: TranscriptContext,
	options: SimpleStreamOptions | undefined,
	state: FauxProviderState,
	model: Model<string>,
) => AssistantMessage | Promise<AssistantMessage>;
export type FauxResponseStep = AssistantMessage | FauxResponseFactory;
export interface RegisterFauxProviderOptions {
	api?: string;
	provider?: string;
	models?: FauxModelDefinition[];
	deferred?: { pendingFetches?: number; pollAfterMs?: number };
	tokensPerSecond?: number;
	tokenSize?: { min?: number; max?: number };
}
interface FauxControls {
	api: string;
	models: [Model<string>, ...Model<string>[]];
	getModel(): Model<string>;
	getModel(modelId: string): Model<string> | undefined;
	state: FauxProviderState;
	setResponses: (responses: FauxResponseStep[]) => void;
	appendResponses: (responses: FauxResponseStep[]) => void;
	getPendingResponseCount: () => number;
}
export interface FauxProviderRegistration extends FauxControls {
	unregister: () => void;
}
export interface FauxProviderHandle extends FauxControls {
	provider: Provider;
}
const tokens = (text: string) => Math.ceil(text.length / 4);
const inputText = (content: string | (TextContent | ImageContent)[]) =>
	typeof content === "string"
		? content
		: content
				.map((block) => (block.type === "text" ? block.text : `[image:${block.mimeType}:${block.data.length}]`))
				.join("\n");
const outputText = (content: FauxContentBlock[]) =>
	content
		.map((block) =>
			block.type === "text"
				? block.text
				: block.type === "thinking"
					? block.thinking
					: `${block.name}:${JSON.stringify(block.arguments)}`,
		)
		.join("\n");
function messageText(message: Message): string {
	switch (message.role) {
		case "system":
			return [
				getSystemMessageText(message),
				...(message.toolsRemoved?.map((tool) => `tool-:${JSON.stringify(tool)}`) ?? []),
				...(message.toolsAdded?.map((tool) => `tool+:${JSON.stringify(tool)}`) ?? []),
			]
				.filter((part) => part.length)
				.join("\n");
		case "user":
			return inputText(message.content);
		case "assistant":
			return outputText(message.content);
		case "toolResult":
			return [message.toolName, ...message.content.map((block) => inputText([block]))].join("\n");
	}
}
function cachedPromptChars(previous: readonly string[], current: readonly string[]): number {
	let index = 0,
		length = 0;
	while (index < previous.length && index < current.length && previous[index] === current[index]) {
		length += previous[index]!.length + (index ? 2 : 0);
		index++;
	}
	if (index === previous.length || index === current.length) return length;
	const before = previous.slice(index).join("\n\n"),
		after = current.slice(index).join("\n\n");
	let prefix = 0;
	while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
	return length + (index ? 2 : 0) + prefix;
}
async function emitMessage(
	output: AssistantMessageEventStream,
	message: AssistantMessage,
	min: number,
	max: number,
	rate?: number,
	signal?: AbortSignal,
): Promise<void> {
	const partial: AssistantMessage = { ...message, content: [], stopReason: "pending" };
	const aborted = () => {
		if (!signal?.aborted) return false;
		const error: AssistantMessage = {
			...partial,
			stopReason: "aborted",
			errorMessage: "Request was aborted",
			timestamp: Date.now(),
		};
		output.push({ type: "error", reason: "aborted", error });
		output.end(error);
		return true;
	};
	async function chunks(
		text: string,
		index: number,
		kind: "text" | "thinking" | "toolcall",
		update: (chunk: string) => void,
	): Promise<boolean> {
		const parts: string[] = [];
		for (let offset = 0; offset < text.length; ) {
			const size = Math.max(1, (min + Math.floor(Math.random() * (max - min + 1))) * 4);
			parts.push(text.slice(offset, offset + size));
			offset += size;
		}
		if (!parts.length) parts.push("");
		for (const part of parts) {
			await new Promise<void>((resolve) => {
				if (rate && rate > 0) setTimeout(resolve, (tokens(part) / rate) * 1000);
				else queueMicrotask(resolve);
			});
			if (aborted()) return false;
			update(part);
			output.push({ type: `${kind}_delta`, contentIndex: index, delta: part, partial: { ...partial } });
		}
		return true;
	}
	if (aborted()) return;
	output.push({ type: "start", partial: { ...partial } });
	for (const [index, block] of message.content.entries()) {
		if (aborted()) return;
		if (block.type === "toolCall") {
			const call: ToolCall = { type: "toolCall", id: block.id, name: block.name, arguments: {} };
			partial.content = [...partial.content, call];
			output.push({ type: "toolcall_start", contentIndex: index, partial: { ...partial } });
			if (!(await chunks(JSON.stringify(block.arguments), index, "toolcall", () => {}))) return;
			call.arguments = block.arguments;
			output.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: { ...partial } });
		} else if (block.type === "text") {
			const text: TextContent = { type: "text", text: "" };
			partial.content = [...partial.content, text];
			output.push({ type: "text_start", contentIndex: index, partial: { ...partial } });
			if (
				!(await chunks(block.text, index, "text", (part) => {
					text.text += part;
				}))
			)
				return;
			output.push({ type: "text_end", contentIndex: index, content: block.text, partial: { ...partial } });
		} else {
			const thinking: ThinkingContent = { type: "thinking", thinking: "" };
			partial.content = [...partial.content, thinking];
			output.push({ type: "thinking_start", contentIndex: index, partial: { ...partial } });
			if (
				!(await chunks(block.thinking, index, "thinking", (part) => {
					thinking.thinking += part;
				}))
			)
				return;
			output.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: { ...partial } });
		}
	}
	if (message.stopReason === "pending") throw new Error("Faux response ended without a stop reason");
	if (message.stopReason === "error" || message.stopReason === "aborted")
		output.push({ type: "error", reason: message.stopReason, error: message });
	else output.push({ type: "done", reason: message.stopReason, message });
	output.end(message);
}
export function createFauxCore(options: RegisterFauxProviderOptions) {
	const api = options.api ?? identifier("faux"),
		provider = options.provider ?? "faux";
	const min = Math.max(1, Math.min(options.tokenSize?.min ?? 3, options.tokenSize?.max ?? 5)),
		max = Math.max(min, options.tokenSize?.max ?? 5);
	const rate = options.tokensPerSecond;
	const state: FauxProviderState = { callCount: 0, deferredFetchCount: 0, cancelledDeferred: [] };
	let responses: FauxResponseStep[] = [];
	const cache = new Map<string, readonly string[]>();
	type Deferred = {
		handle: DeferredHandle;
		step: FauxResponseStep;
		context: TranscriptContext;
		options: SimpleStreamOptions | undefined;
		model: Model<string>;
		remaining: number;
		cancelled: boolean;
		final?: AssistantMessage;
	};
	const deferred = new Map<string, Deferred>();
	const definitions: FauxModelDefinition[] = options.models?.length
		? options.models
		: [{ id: "faux-1", name: "Faux Model" }];
	const modelFrom = (definition: FauxModelDefinition): Model<string> => ({
		id: definition.id,
		name: definition.name ?? definition.id,
		api,
		provider,
		baseUrl: "http://localhost:0",
		reasoning: definition.reasoning ?? false,
		input: definition.input ?? ["text", "image"],
		inputLimits: definition.inputLimits,
		cost: definition.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: definition.contextWindow ?? 128000,
		maxTokens: definition.maxTokens ?? 16384,
	});
	const models: [Model<string>, ...Model<string>[]] = [
		modelFrom(definitions[0]!),
		...definitions.slice(1).map(modelFrom),
	];
	const usage = (
		message: AssistantMessage,
		context: TranscriptContext,
		options: StreamOptions | undefined,
	): AssistantMessage => {
		const prompt = context.messages.map((message) => `${message.role}:${messageText(message)}`);
		const length = prompt.reduce((size, part, index) => size + part.length + (index ? 2 : 0), 0);
		let input = Math.ceil(length / 4),
			cacheRead = 0,
			cacheWrite = 0;
		if (options?.sessionId && options.cacheRetention !== "none") {
			const old = cache.get(options.sessionId);
			if (old !== undefined) {
				const prefix = cachedPromptChars(old, prompt);
				cacheRead = Math.ceil(prefix / 4);
				cacheWrite = Math.ceil((length - prefix) / 4);
				input = Math.max(0, input - cacheRead);
			} else cacheWrite = input;
			cache.set(options.sessionId, prompt);
		}
		const output = tokens(outputText(message.content));
		return {
			...message,
			usage: {
				input,
				output,
				cacheRead,
				cacheWrite,
				totalTokens: input + output + cacheRead + cacheWrite,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
	};
	const errorMessage = (error: unknown, modelId: string): AssistantMessage => ({
		role: "assistant",
		content: [],
		api,
		provider,
		model: modelId,
		usage: emptyUsage,
		stopReason: "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	});
	const deferredMessage = (model: Model<string>, handle: DeferredHandle): AssistantMessage => ({
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage,
		stopReason: "deferred",
		deferred: handle,
		timestamp: Date.now(),
	});
	const resolve = async (
		step: FauxResponseStep,
		context: TranscriptContext,
		settings: SimpleStreamOptions | undefined,
		model: Model<string>,
	) => {
		const resolved = structuredClone(typeof step === "function" ? await step(context, settings, state, model) : step);
		return usage(
			{
				...resolved,
				api,
				provider,
				model: model.id,
				timestamp: resolved.timestamp ?? Date.now(),
				usage: resolved.usage ?? emptyUsage,
			},
			context,
			settings,
		);
	};
	const launch = (model: Model<string>, run: (output: AssistantMessageEventStream) => Promise<void>) => {
		const output = createAssistantMessageEventStream();
		queueMicrotask(() => {
			void run(output).catch((error) => {
				const message = errorMessage(error, model.id);
				output.push({ type: "error", reason: "error", error: message });
				output.end(message);
			});
		});
		return output;
	};
	const stream: StreamFunction<string, SimpleStreamOptions> = (model, context, settings) => {
		const step = responses.shift();
		state.callCount++;
		return launch(model, async (output) => {
			await settings?.onResponse?.({ status: 200, headers: {} }, model);
			if (!step) {
				const message = usage(errorMessage(new Error("No more faux responses queued"), model.id), context, settings);
				output.push({ type: "error", reason: "error", error: message });
				output.end(message);
				return;
			}
			if (settings?.deferred) {
				const handle: DeferredHandle = {
					provider: model.provider,
					modelId: model.id,
					api: model.api,
					id: identifier("deferred"),
					...(options.deferred?.pollAfterMs === undefined ? {} : { pollAfterMs: options.deferred.pollAfterMs }),
				};
				deferred.set(handle.id, {
					handle,
					step,
					context,
					options: settings,
					model,
					remaining: Math.max(0, Math.floor(options.deferred?.pendingFetches ?? 0)),
					cancelled: false,
				});
				await emitMessage(output, deferredMessage(model, handle), min, max, rate, settings.signal);
			} else await emitMessage(output, await resolve(step, context, settings, model), min, max, rate, settings?.signal);
		});
	};
	const fetchDeferred = (
		model: Model<string>,
		handle: DeferredHandle,
		settings?: DeferredFetchOptions,
	): AssistantMessageEventStream => {
		state.deferredFetchCount++;
		return launch(model, async (output) => {
			await settings?.onResponse?.({ status: 200, headers: {} }, model);
			const entry = deferred.get(handle.id);
			if (
				!entry ||
				entry.handle.provider !== handle.provider ||
				entry.handle.modelId !== handle.modelId ||
				entry.handle.api !== handle.api
			)
				throw new Error(`Unknown faux deferred response: ${handle.id}`);
			if (entry.cancelled) throw new Error(`Faux deferred response was cancelled: ${handle.id}`);
			if (entry.remaining > 0) {
				entry.remaining--;
				await emitMessage(output, deferredMessage(model, entry.handle), min, max, rate, settings?.signal);
				return;
			}
			if (!entry.final) {
				const { deferred: _deferred, signal: _signal, onResponse: _response, ...submission } = entry.options ?? {};
				try {
					entry.final = await resolve(entry.step, entry.context, submission, entry.model);
				} catch (error) {
					entry.final = errorMessage(error, entry.model.id);
				}
			}
			await emitMessage(output, entry.final, min, max, rate, settings?.signal);
		});
	};
	const cancelDeferred = async (
		model: Model<string>,
		handle: DeferredHandle,
		settings?: DeferredCancelOptions,
	): Promise<void> => {
		state.cancelledDeferred.push(structuredClone(handle));
		const entry = deferred.get(handle.id);
		if (entry) entry.cancelled = true;
		await settings?.onResponse?.({ status: 200, headers: {} }, model);
	};
	function getModel(): Model<string>;
	function getModel(id: string): Model<string> | undefined;
	function getModel(id?: string): Model<string> | undefined {
		return id ? models.find((model) => model.id === id) : models[0];
	}
	return {
		api,
		provider,
		models,
		stream,
		streamSimple: (model: Model<string>, context: TranscriptContext, settings?: SimpleStreamOptions) =>
			stream(model, context, settings),
		fetchDeferred,
		cancelDeferred,
		getModel,
		state,
		setResponses(next: FauxResponseStep[]) {
			responses = [...next];
		},
		appendResponses(next: FauxResponseStep[]) {
			responses.push(...next);
		},
		getPendingResponseCount() {
			return responses.length;
		},
	};
}
export function fauxProvider(options: RegisterFauxProviderOptions = {}): FauxProviderHandle {
	const core = createFauxCore(options);
	const provider = createProvider({
		id: core.provider,
		auth: { apiKey: { name: "Faux", resolve: async () => ({ auth: {} }) } },
		models: core.models,
		api: {
			stream: core.stream,
			streamSimple: core.streamSimple,
			fetchDeferred: core.fetchDeferred,
			cancelDeferred: core.cancelDeferred,
		},
	});
	return {
		provider,
		api: core.api,
		models: core.models,
		getModel: core.getModel,
		state: core.state,
		setResponses: core.setResponses,
		appendResponses: core.appendResponses,
		getPendingResponseCount: core.getPendingResponseCount,
	};
}
