import type { Api, AssistantMessage, AssistantMessageEvent, Model, ProviderStreams } from "../types.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
export interface LazyStreamObserver {
	onEvent?(event: AssistantMessageEvent): void;
	onResult?(result: AssistantMessage | undefined): void;
}
export function lazyStream(
	model: Model<Api>,
	setup: () => Promise<AsyncIterable<AssistantMessageEvent>>,
	observer?: LazyStreamObserver,
): AssistantMessageEventStream {
	const timestamp = Date.now(),
		output = new AssistantMessageEventStream();
	let observed = false;
	const complete = (result: AssistantMessage | undefined): void => {
		if (observed) return;
		observed = true;
		observer?.onResult?.(result);
	};
	void setup()
		.then(async (source) => {
			let result: AssistantMessage | undefined;
			for await (const event of source) {
				output.push(event);
				observer?.onEvent?.(event);
				if (event.type === "done") result = event.message;
				else if (event.type === "error") result = event.error;
			}
			const hasResult = (
				value: AsyncIterable<AssistantMessageEvent>,
			): value is AsyncIterable<AssistantMessageEvent> & { result(): Promise<AssistantMessage> } =>
				typeof (value as { result?: unknown }).result === "function";
			if (hasResult(source)) result = await source.result();
			output.end(result);
			complete(result);
		})
		.catch((error) => {
			const message: AssistantMessage = {
				role: "assistant",
				content: [],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "error",
				errorMessage: error instanceof Error ? error.message : String(error),
				timestamp,
			};
			const event: AssistantMessageEvent = { type: "error", reason: "error", error: message };
			output.push(event);
			observer?.onEvent?.(event);
			output.end(message);
			complete(message);
		});
	return output;
}
export interface LazyApiCapabilities {
	fetchDeferred?: boolean;
	cancelDeferred?: boolean;
}
export function lazyApi(load: () => Promise<ProviderStreams>, capabilities?: LazyApiCapabilities): ProviderStreams {
	const result: ProviderStreams = {
		stream: (model, context, options) => lazyStream(model, async () => (await load()).stream(model, context, options)),
		streamSimple: (model, context, options) =>
			lazyStream(model, async () => (await load()).streamSimple(model, context, options)),
	};
	if (capabilities?.fetchDeferred)
		result.fetchDeferred = (model, handle, options) =>
			lazyStream(model, async () => {
				const api = await load();
				if (!api.fetchDeferred) throw new Error("API does not support deferred responses");
				return api.fetchDeferred(model, handle, options);
			});
	if (capabilities?.cancelDeferred)
		result.cancelDeferred = async (model, handle, options) => {
			const api = await load();
			if (!api.cancelDeferred) throw new Error("API cannot cancel deferred responses");
			await api.cancelDeferred(model, handle, options);
		};
	return result;
}
