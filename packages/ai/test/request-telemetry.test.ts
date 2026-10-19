import { InMemoryTelemetryContext } from "@axi/telemetry";
import { describe, expect, it } from "vitest";
import { createModels, createProvider } from "../src/models.ts";
import { fauxAssistantMessage, fauxToolCall } from "../src/providers/faux.ts";
import type { Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

const model: Model<"local"> = {
	id: "local",
	name: "Local",
	api: "local",
	provider: "local",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	contextWindow: 1000,
	maxTokens: 100,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
describe("request measurements", () => {
	it("selects its parent after reading the requested reasoning level", async () => {
		const recorder = new InMemoryTelemetryContext();
		const models = createModels();
		const result = fauxAssistantMessage([]);
		const respond = () => {
			const stream = new AssistantMessageEventStream();
			stream.push({ type: "done", reason: "stop", message: result });
			stream.end(result);
			return stream;
		};
		models.setProvider(
			createProvider({
				id: "local",
				models: [model],
				auth: { apiKey: { name: "Local", resolve: async () => ({ auth: {} }) } },
				api: { stream: respond, streamSimple: respond },
			}),
		);
		await recorder.startSpan({ name: "first" }, async (first) =>
			recorder.startSpan({ name: "second" }, async (second) => {
				let selected = first;
				expect(
					await models.completeSimple(
						model,
						{ messages: [] },
						{
							get telemetry() {
								return selected;
							},
							get reasoning(): "high" {
								selected = second;
								return "high";
							},
						},
					),
				).toBe(result);
			}),
		);
		const spans = recorder.getSpans();
		const request = spans.find((span) => span.name === "axi.ai.request");
		expect(request?.parentId).toBe(spans.find((span) => span.name === "second")?.id);
		expect(request?.attributes.reasoning).toBe("high");
	});
	it("records block metadata and parentage while preserving event and result identity", async () => {
		const recorder = new InMemoryTelemetryContext();
		const result = fauxAssistantMessage([fauxToolCall("lookup", { private: "argument" }, { id: "call" })], {
			stopReason: "toolUse",
		});
		const call = result.content[0];
		if (call.type !== "toolCall") throw new Error("Expected a tool call");
		const done = { type: "done", reason: "toolUse", message: result } as const;
		const models = createModels();
		const respond = () => {
			const stream = new AssistantMessageEventStream();
			stream.push({ type: "toolcall_delta", contentIndex: 0, delta: "private", partial: result });
			stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: result });
			stream.push(done);
			stream.end(result);
			return stream;
		};
		models.setProvider(
			createProvider({
				id: "local",
				models: [model],
				auth: { apiKey: { name: "Local", resolve: async () => ({ auth: {} }) } },
				api: { stream: respond, streamSimple: respond },
			}),
		);
		await recorder.startSpan({ name: "caller" }, async (span) => {
			const response = models.streamSimple(model, { messages: [] }, { telemetry: span });
			const events = [];
			for await (const event of response) events.push(event);
			expect(events.at(-1)).toBe(done);
			expect(await response.result()).toBe(result);
		});
		const [caller, request] = recorder.getSpans();
		expect(request.name).toBe("axi.ai.request");
		expect(request.parentId).toBe(caller.id);
		expect(request.events).toEqual([
			{ name: "axi.ai.first_chunk", attributes: {} },
			{ name: "axi.ai.block", attributes: { type: "tool_call", index: 0, chars: 7, tool: "lookup" } },
		]);
		expect(JSON.stringify(request)).not.toContain("private");
		expect(recorder.getMetrics().map(({ kind }) => kind)).toEqual([
			"histogram",
			"histogram",
			"counter",
			"counter",
			"counter",
			"counter",
			"counter",
		]);
	});
});
