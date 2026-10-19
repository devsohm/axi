import {
	createTypedMetrics,
	createTypedSpanStarter,
	defineTelemetrySchema,
	NOOP_TELEMETRY_CONTEXT,
	NOOP_TELEMETRY_METRICS,
	type SchemaTelemetrySpan,
	type TelemetryMetrics,
	type TelemetrySpan,
} from "@axi/telemetry";
import type { LazyStreamObserver } from "./api/lazy.ts";
import type { Api, Model } from "./types.ts";

const provider = { type: "string", description: "Provider ID.", required: true } as const;
const model = { type: "string", description: "Requested model ID.", required: true } as const;
const stop = {
	type: "string",
	description: "Normalized completion state.",
	values: ["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"],
} as const;
const request = {
	description: "Model request from authentication through its terminal result.",
	parents: { kind: "any" },
	startAttributes: {
		provider,
		model,
		api: { type: "string", description: "API ID.", required: true },
		reasoning: { type: "string", description: "Requested scalar reasoning level.", required: false },
	},
	endAttributes: {
		stop,
		"usage.input": { type: "number", description: "Uncached input tokens." },
		"usage.output": { type: "number", description: "Output tokens." },
		"usage.cache_read": { type: "number", description: "Tokens read from cache." },
		"usage.cache_write": { type: "number", description: "Tokens written to cache." },
		"cost.total": { type: "number", description: "Reported USD cost." },
		"response.id": { type: "string", description: "Response ID.", cardinality: "high" },
	},
	events: {
		"axi.ai.first_chunk": { description: "First delivered normalized event.", attributes: {} },
		"axi.ai.block": {
			description: "Completed block metadata without content.",
			attributes: {
				type: { type: "string", description: "Block kind.", values: ["text", "thinking", "tool_call"], required: true },
				index: { type: "number", description: "Block index.", required: true },
				chars: { type: "number", description: "UTF-16 length.", required: true },
				tool: { type: "string", description: "Tool name.", required: false },
			},
		},
	},
	status: {
		default: "ok",
		errorWhen: "Error results use provider_error and at most 500 message characters; cancellation stays ok.",
	},
} as const;
export const AI_TELEMETRY_SCHEMA = defineTelemetrySchema({
	version: 1,
	spans: {
		"axi.ai.request": request,
		"axi.ai.poll": { ...request, description: "One deferred-response poll." },
	},
	metrics: {
		"axi.ai.request.duration": {
			kind: "histogram",
			description: "Request or poll duration.",
			unit: "ms",
			attributes: { provider, model, stop: { ...stop, required: true } },
		},
		"axi.ai.first_chunk.duration": {
			kind: "histogram",
			description: "Time until the first event.",
			unit: "ms",
			attributes: { provider, model },
		},
		"axi.ai.tokens": {
			kind: "counter",
			description: "Reported token usage, excluding unfinished polls.",
			unit: "token",
			attributes: {
				provider,
				model,
				kind: {
					type: "string",
					description: "Token category.",
					values: ["input", "output", "cache_read", "cache_write"],
					required: true,
				},
			},
		},
		"axi.ai.cost": {
			kind: "counter",
			description: "Reported cost, excluding unfinished polls.",
			unit: "USD",
			attributes: { provider, model },
		},
	},
});
function instruments(adapter: TelemetryMetrics) {
	const typed = createTypedMetrics(adapter, [AI_TELEMETRY_SCHEMA]);
	return {
		duration: typed.histogram("axi.ai.request.duration"),
		first: typed.histogram("axi.ai.first_chunk.duration"),
		tokens: typed.counter("axi.ai.tokens"),
		cost: typed.counter("axi.ai.cost"),
	};
}
const cached = new WeakMap<TelemetryMetrics, ReturnType<typeof instruments>>();
export function observeModelRequest(
	requested: Model<Api>,
	options: { telemetry?: TelemetrySpan; reasoning?: unknown } | undefined,
	poll: boolean,
): LazyStreamObserver {
	const started = performance.now();
	const labels = { provider: requested.provider, model: requested.id };
	const adapter = options?.telemetry?.metrics ?? NOOP_TELEMETRY_METRICS;
	let meters = cached.get(adapter);
	if (!meters) {
		meters = instruments(adapter);
		cached.set(adapter, meters);
	}
	const { duration, first, tokens, cost } = meters;
	let active!: SchemaTelemetrySpan<typeof AI_TELEMETRY_SCHEMA, "axi.ai.request">;
	let resolve!: () => void;
	let firstEvent = true;
	const lengths = new Map<number, number>();
	const done = new Promise<void>((settle) => {
		resolve = settle;
	});
	const attributes = {
		...labels,
		api: requested.api,
		...(typeof options?.reasoning === "string" ? { reasoning: options.reasoning } : {}),
	};
	const start = createTypedSpanStarter(options?.telemetry ?? NOOP_TELEMETRY_CONTEXT, [AI_TELEMETRY_SCHEMA]);
	const observe = (span: SchemaTelemetrySpan<typeof AI_TELEMETRY_SCHEMA, "axi.ai.request">): Promise<void> => {
		active = span;
		return done;
	};
	if (poll) void start("axi.ai.poll", attributes, observe);
	else void start("axi.ai.request", attributes, observe);
	return {
		onEvent(event) {
			if (firstEvent) {
				firstEvent = false;
				active.addEvent("axi.ai.first_chunk");
				first.record(performance.now() - started, labels, active);
			}
			switch (event.type) {
				case "toolcall_delta":
					lengths.set(event.contentIndex, (lengths.get(event.contentIndex) ?? 0) + event.delta.length);
					break;
				case "text_end":
				case "thinking_end":
					active.addEvent("axi.ai.block", {
						type: event.type === "text_end" ? "text" : "thinking",
						index: event.contentIndex,
						chars: event.content.length,
					});
					break;
				case "toolcall_end": {
					const chars = lengths.get(event.contentIndex) ?? 0;
					lengths.delete(event.contentIndex);
					active.addEvent("axi.ai.block", {
						type: "tool_call",
						index: event.contentIndex,
						chars,
						tool: event.toolCall.name,
					});
					break;
				}
			}
		},
		onResult(message) {
			if (message) {
				const { usage, stopReason } = message;
				active.setAttributes({
					stop: stopReason,
					"usage.input": usage.input,
					"usage.output": usage.output,
					"usage.cache_read": usage.cacheRead,
					"usage.cache_write": usage.cacheWrite,
					"cost.total": usage.cost.total,
					"response.id": message.responseId,
				});
				if (stopReason === "error")
					active.setStatus({
						status: "error",
						error: { name: "provider_error", message: message.errorMessage?.slice(0, 500) ?? "" },
					});
				duration.record(performance.now() - started, { ...labels, stop: stopReason }, active);
				if (!poll || (stopReason !== "pending" && stopReason !== "deferred")) {
					tokens.add(usage.input, { ...labels, kind: "input" });
					tokens.add(usage.output, { ...labels, kind: "output" });
					tokens.add(usage.cacheRead, { ...labels, kind: "cache_read" });
					tokens.add(usage.cacheWrite, { ...labels, kind: "cache_write" });
					cost.add(usage.cost.total, labels);
				}
			}
			resolve();
		},
	};
}
