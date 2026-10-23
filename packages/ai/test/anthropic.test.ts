import Anthropic from "@anthropic-ai/sdk";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { type AnthropicOptions, stream, streamSimple } from "../src/api/anthropic-messages.ts";
import type { AssistantMessage, Model, Tool } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"anthropic-messages"> = {
	id: "claude-test",
	name: "Test",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://provider.invalid",
	reasoning: true,
	input: ["text", "image"],
	contextWindow: 100_000,
	maxTokens: 5000,
	cost: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 3 },
};
const context = normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 1 }] });
const tool: Tool = {
	name: "read",
	description: "Read",
	parameters: Type.Object({ path: Type.String(), extra: Type.Optional(Type.Number()) }),
	constrainedSampling: { type: "json_schema", strict: "prefer" },
};
const start = {
	type: "message_start",
	message: {
		id: "response-1",
		model: "served-model",
		usage: {
			input_tokens: 100,
			output_tokens: 0,
			cache_read_input_tokens: 30,
			cache_creation_input_tokens: 20,
			cache_creation: { ephemeral_1h_input_tokens: 10 },
		},
	},
};
const stop = {
	type: "message_delta",
	delta: { stop_reason: "end_turn" },
	usage: { output_tokens: 20, output_tokens_details: { thinking_tokens: 5 } },
};
const end = { type: "message_stop" };
function response(events: object[]): Response {
	return new Response(
		events
			.map((event) => `event: ${"type" in event ? event.type : "unknown"}\ndata: ${JSON.stringify(event)}\n\n`)
			.join(""),
		{ headers: { "content-type": "text/event-stream", "x-request-id": "request-1" } },
	);
}
function answer(): Response {
	return response([
		start,
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "answer" } },
		{ type: "content_block_stop", index: 0 },
		stop,
		end,
	]);
}
function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		timestamp: 2,
		stopReason: "toolUse",
		content,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

describe("Anthropic messages", () => {
	it("reads CR and LF event lines when UTF-8 bytes arrive separately", async () => {
		const events = [
			start,
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "héllo 🌍" } },
			{ type: "content_block_stop", index: 0 },
			stop,
			end,
		];
		const text = await response(events).text();
		for (const newline of ["\r", "\n"]) {
			const bytes = new TextEncoder().encode(text.replaceAll("\n", newline));
			const result = await stream(model, context, {
				apiKey: "fixture",
				fetch: async () =>
					new Response(
						new ReadableStream({
							start(controller) {
								for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
								controller.close();
							},
						}),
						{ headers: { "content-type": "text/event-stream" } },
					),
			}).result();
			expect(result.stopReason, JSON.stringify(newline)).toBe("stop");
			expect(result.content).toEqual([{ type: "text", text: "héllo 🌍" }]);
			expect(result.usage.input).toBe(100);
		}
	});

	it("reuses the deferred tool placeholder across requests", async () => {
		const descriptions: string[] = [];
		let retained: Record<"description", unknown> | undefined;
		let original = "";
		try {
			for (let index = 0; index < 2; index++) {
				const result = await stream(
					{ ...model, compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true } },
					normalizeContext({ messages: context.messages, tools: [tool] }),
					{
						apiKey: "fixture",
						fetch: async () => answer(),
						onPayload(payload) {
							if (
								typeof payload !== "object" ||
								payload === null ||
								!("tools" in payload) ||
								!Array.isArray(payload.tools)
							)
								throw new Error("Expected tool definitions");
							const placeholder: unknown = payload.tools.at(-1);
							if (
								typeof placeholder !== "object" ||
								placeholder === null ||
								!("description" in placeholder) ||
								typeof placeholder.description !== "string"
							)
								throw new Error("Expected a tool description");
							descriptions.push(placeholder.description);
							if (index === 0) {
								retained = placeholder;
								original = placeholder.description;
								placeholder.description = "Changed by the application";
							}
						},
					},
				).result();
				expect(result.stopReason).toBe("stop");
			}
			expect(descriptions).toEqual([
				"Reserved placeholder. Never available. Never call this.",
				"Changed by the application",
			]);
		} finally {
			if (retained) retained.description = original;
		}
	});

	it("exposes active tool JSON and removes streaming fields at block completion", async () => {
		const frames = await Promise.all(
			[
				start,
				{
					type: "content_block_start",
					index: 0,
					content_block: { type: "tool_use", id: "a", name: "read", input: {} },
				},
				{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"a"}' } },
				{ type: "content_block_stop", index: 0 },
				{ ...stop, delta: { stop_reason: "tool_use" } },
				end,
			].map((event) => response([event]).text()),
		);
		let at = 0;
		const events = stream(model, context, {
			apiKey: "test",
			fetch: async () =>
				new Response(
					new ReadableStream({
						async pull(controller) {
							await new Promise<void>((resolve) => setImmediate(resolve));
							if (at === frames.length) controller.close();
							else controller.enqueue(new TextEncoder().encode(frames[at++]));
						},
					}),
					{ headers: { "content-type": "text/event-stream" } },
				),
		});
		const snapshots: unknown[] = [];
		for await (const event of events)
			if (event.type === "toolcall_start" || event.type === "toolcall_delta" || event.type === "toolcall_end")
				snapshots.push(structuredClone(event.partial.content[0]));
		expect(snapshots).toEqual([
			{ type: "toolCall", id: "a", name: "read", arguments: {}, partialJson: "", index: 0 },
			{ type: "toolCall", id: "a", name: "read", arguments: { path: "a" }, partialJson: '{"path":"a"}', index: 0 },
			{ type: "toolCall", id: "a", name: "read", arguments: { path: "a" } },
		]);
		expect((await events.result()).content).toEqual([
			{ type: "toolCall", id: "a", name: "read", arguments: { path: "a" } },
		]);
	});
	it("keeps the selected request timeout when the payload callback changes options", async () => {
		const client = new Anthropic({ apiKey: "test", fetch: async () => answer() });
		const request = vi.spyOn(client.beta.messages, "create");
		try {
			const options: AnthropicOptions = {
				client,
				timeoutMs: 1000,
				onPayload() {
					options.timeoutMs = 2000;
				},
			};
			const result = await stream(model, context, options).result();
			expect(result.stopReason).toBe("stop");
			expect(request.mock.calls[0]?.[1]?.timeout).toBe(1000);
		} finally {
			request.mockRestore();
		}
	});
	it("streams signed and redacted thinking, finalizes arguments and attributes fallback costs", async () => {
		const events = stream(
			{
				...model,
				compat: {
					allowedFallbackModels: [
						{
							provider: "anthropic",
							model: "served-model",
							cost: { input: 3, output: 9, cacheRead: 1, cacheWrite: 5 },
						},
					],
				},
			},
			context,
			{
				apiKey: "test",
				fetch: async () =>
					response([
						start,
						{
							type: "content_block_start",
							index: 0,
							content_block: { type: "thinking", thinking: "initial", signature: "signed" },
						},
						{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: " more" } },
						{ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: ":more" } },
						{ type: "content_block_stop", index: 0 },
						{ type: "content_block_start", index: 1, content_block: { type: "redacted_thinking", data: "opaque" } },
						{ type: "content_block_stop", index: 1 },
						{
							type: "content_block_start",
							index: 2,
							content_block: { type: "tool_use", id: "call-1", name: "read", input: {} },
						},
						{ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"path":' } },
						{ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '"a"}' } },
						{ type: "content_block_stop", index: 2 },
						{
							...stop,
							delta: { stop_reason: "tool_use" },
							input_transformations: [{ type: "thinking_dropped", path: "one", reason: "prefix_binding_mismatch" }],
						},
						end,
					]),
			},
		);
		const kinds: string[] = [];
		for await (const event of events) kinds.push(event.type);
		const result = await events.result();
		expect(kinds).toEqual([
			"start",
			"thinking_start",
			"thinking_delta",
			"thinking_end",
			"thinking_start",
			"thinking_end",
			"toolcall_start",
			"toolcall_delta",
			"toolcall_delta",
			"toolcall_end",
			"done",
		]);
		expect(result).toMatchObject({
			stopReason: "toolUse",
			responseId: "response-1",
			responseModel: "served-model",
			content: [
				{ type: "thinking", thinking: "initial more", thinkingSignature: "signed:more" },
				{ type: "thinking", thinking: "[Reasoning redacted]", thinkingSignature: "opaque", redacted: true },
				{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a" } },
			],
			usage: {
				input: 100,
				output: 20,
				cacheRead: 30,
				cacheWrite: 20,
				cacheWrite1h: 10,
				reasoning: 5,
				totalTokens: 170,
			},
			diagnostics: [
				{
					type: "anthropic_input_transformations",
					details: { transformations: [{ type: "thinking_dropped", path: "one", reason: "prefix_binding_mismatch" }] },
				},
			],
		});
		expect(result.usage.cost.total).toBeCloseTo(0.00062, 12);
	});
	it("reconstructs historical effort markers and appends the current effort", async () => {
		let body = "";
		const selected = {
			...model,
			compat: { forceAdaptiveThinking: true, supportsMidConvoEffort: true },
			thinkingLevelMap: { off: null, high: "xhigh" },
		} satisfies Model<"anthropic-messages">;
		const prior = { ...assistant([{ type: "text", text: "prior" }]), providerThinkingLevel: "low" };
		const result = await streamSimple(
			selected,
			normalizeContext({ messages: [...context.messages, prior, { role: "user", content: "again", timestamp: 3 }] }),
			{
				apiKey: "test",
				reasoning: "high",
				temperature: 0.7,
				fetch: async (_url, init) => {
					body = String(init?.body);
					return answer();
				},
			},
		).result();
		expect(result.providerThinkingLevel).toBe("xhigh");
		expect(JSON.parse(body)).toMatchObject({
			output_config: { effort: "low" },
			thinking: { type: "adaptive", display: "summarized", block_binding: { prefix_mismatch_behavior: "drop_block" } },
			messages: [
				{ role: "user" },
				{ role: "system", content: [], output_config: { effort: "low" } },
				{ role: "assistant" },
				{ role: "user" },
				{ role: "system", content: [], output_config: { effort: "xhigh" } },
			],
		});
		expect(JSON.parse(body).temperature).toBeUndefined();
	});
	it("reserves answer room for budget-based thinking", async () => {
		let body = "";
		const result = await streamSimple(model, context, {
			apiKey: "test",
			reasoning: "high",
			maxTokens: 2000,
			thinkingBudgets: { high: 6000 },
			fetch: async (_url, init) => {
				body = String(init?.body);
				return answer();
			},
		}).result();
		expect(result.content).toEqual([{ type: "text", text: "answer" }]);
		expect(JSON.parse(body)).toMatchObject({
			max_tokens: 5000,
			thinking: { type: "enabled", budget_tokens: 3976, display: "summarized" },
		});
	});
	it("keeps tool results adjacent while moving error images and system updates to valid positions", async () => {
		let body = "";
		const transcript = normalizeContext({
			systemPrompt: "rules",
			tools: [tool],
			messages: [
				...context.messages,
				assistant([{ type: "toolCall", id: "a", name: "read", arguments: {} }]),
				{
					role: "system",
					content: "later",
					toolsAdded: [{ ...tool, name: "write" }],
					toolsRemoved: [tool],
					timestamp: 3,
				},
				{
					role: "toolResult",
					toolCallId: "a",
					toolName: "read",
					isError: true,
					content: [
						{ type: "text", text: "failed" },
						{ type: "image", data: "AA==", mimeType: "image/png" },
					],
					timestamp: 4,
				},
			],
		});
		const result = await stream(
			{ ...model, compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true } },
			transcript,
			{
				apiKey: "test",
				cacheRetention: "none",
				fetch: async (_url, init) => {
					body = String(init?.body);
					return answer();
				},
			},
		).result();
		expect(result.stopReason).toBe("stop");
		const payload = JSON.parse(body);
		expect(payload.tools.map((tool: { name: string }) => tool.name)).toEqual(["read", "__axi_deferred_placeholder__"]);
		expect(payload.messages.map((message: { role: string }) => message.role)).toEqual([
			"user",
			"assistant",
			"user",
			"system",
		]);
		expect(payload.messages[2].content.map((block: { type: string }) => block.type)).toEqual([
			"tool_result",
			"text",
			"image",
		]);
		expect(payload.messages[2].content[0]).toMatchObject({
			is_error: true,
			content: "failed\n(image attached after the tool results)",
		});
		expect(payload.messages[3].content.map((block: { type: string }) => block.type)).toEqual([
			"text",
			"tool_removal",
			"tool_addition",
		]);
	});
	it("downgrades only preferred strict tools after a specific HTTP rejection", async () => {
		const payloads: Array<{ stream: boolean; tools: Array<{ strict?: boolean; input_schema: unknown }> }> = [];
		const transcript = normalizeContext({
			messages: context.messages,
			tools: [tool, { ...tool, name: "required", constrainedSampling: { type: "json_schema", strict: "require" } }],
		});
		const original = JSON.stringify(transcript);
		const result = await stream({ ...model, compat: { supportsStrictTools: true } }, transcript, {
			apiKey: "test",
			maxRetries: 0,
			onPayload: (body) => ({ ...(body as object), stream: false }),
			fetch: async (_url, init) => {
				payloads.push(JSON.parse(String(init?.body)));
				return payloads.length === 1
					? Response.json(
							{ type: "error", error: { type: "invalid_request_error", message: "The compiled grammar is too large" } },
							{ status: 400 },
						)
					: answer();
			},
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(payloads.map((body) => body.stream)).toEqual([true, true]);
		expect(payloads.map((body) => body.tools.map((tool) => tool.strict))).toEqual([
			[true, true],
			[undefined, true],
		]);
		expect(payloads[1].tools[0].input_schema).toEqual({
			type: "object",
			properties: { path: { type: "string" }, extra: { type: "number" } },
			required: ["path"],
		});
		expect(result.diagnostics?.[0]).toMatchObject({
			type: "anthropic_strict_tools_fallback",
			details: { reason: "strict_tool_limits_exceeded" },
		});
		expect(JSON.stringify(transcript)).toBe(original);
	});
	it("keeps required constraints and never retries after an SSE rejection", async () => {
		for (const [strict, sse] of [
			["require", false],
			["prefer", true],
		] as const) {
			let requests = 0;
			const result = await stream(
				{ ...model, compat: { supportsStrictTools: true } },
				normalizeContext({
					messages: context.messages,
					tools: [{ ...tool, constrainedSampling: { type: "json_schema", strict } }],
				}),
				{
					apiKey: "test",
					maxRetries: 0,
					fetch: async () => {
						requests++;
						return sse
							? new Response('event: error\ndata: {"error":{"message":"The compiled grammar is too large"}}\n\n', {
									headers: { "content-type": "text/event-stream" },
								})
							: Response.json(
									{
										type: "error",
										error: { type: "invalid_request_error", message: "The compiled grammar is too large" },
									},
									{ status: 400 },
								);
					},
				},
			).result();
			expect(result).toMatchObject({
				stopReason: "error",
				errorMessage: expect.stringContaining("The compiled grammar is too large"),
			});
			expect(requests).toBe(1);
		}
	});
	it("repairs malformed SSE and final JSON arguments without repairing incomplete calls", async () => {
		const wire =
			'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"A\\H\\"}"}}\n\n';
		const initial = response([
			start,
			{ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "a", name: "read", input: {} } },
		]);
		const body =
			(await initial.text()) +
			wire +
			(await response([
				{ type: "content_block_stop", index: 0 },
				{ ...stop, delta: { stop_reason: "tool_use" } },
				end,
			]).text());
		const result = await stream(model, context, {
			apiKey: "test",
			fetch: async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
		}).result();
		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toEqual([{ type: "toolCall", id: "a", name: "read", arguments: { path: "A\\H" } }]);
	});
	it("retains partial output and usage when the connection closes before message_stop", async () => {
		const result = await stream(model, context, {
			apiKey: "test",
			fetch: async () =>
				response([
					start,
					{ type: "content_block_start", index: 0, content_block: { type: "text", text: "partial" } },
					stop,
				]),
		}).result();
		expect(result).toMatchObject({
			stopReason: "error",
			errorMessage: "Anthropic stream ended before message_stop",
			content: [{ type: "text", text: "partial" }],
			usage: { input: 100, output: 20 },
		});
	});
	it("preserves refusal explanations and rejects unsupported fallback after output", async () => {
		const refusal = await stream(model, context, {
			apiKey: "test",
			fetch: async () =>
				response([
					start,
					{
						...stop,
						delta: { stop_reason: "refusal", stop_details: { type: "refusal", explanation: "Request declined" } },
					},
					end,
				]),
		}).result();
		expect(refusal).toMatchObject({ stopReason: "error", rawStopReason: "refusal", errorMessage: "Request declined" });
		const fallback = await stream(model, context, {
			apiKey: "test",
			fetch: async () =>
				response([
					start,
					{ type: "content_block_start", index: 0, content_block: { type: "text", text: "partial" } },
					{ type: "content_block_start", index: 1, content_block: { type: "fallback" } },
				]),
		}).result();
		expect(fallback).toMatchObject({
			stopReason: "error",
			errorMessage: "Anthropic performed an unsupported mid-output model fallback",
			content: [{ type: "text", text: "partial" }],
		});
	});
});

it("keeps pending system changes after users when an empty assistant is dropped", async () => {
	let body = "";
	const result = await stream(
		{ ...model, compat: { supportsMidConvoSystemMessages: true } },
		normalizeContext({
			messages: [
				...context.messages,
				{ role: "system", content: "updated rules", timestamp: 2 },
				assistant([{ type: "text", text: "  " }]),
				{ role: "user", content: "next question", timestamp: 3 },
			],
		}),
		{
			apiKey: "offline",
			cacheRetention: "none",
			fetch: async (_url, init) => {
				body = String(init?.body);
				return answer();
			},
		},
	).result();
	expect(result.stopReason).toBe("stop");
	expect(JSON.parse(body).messages.map((message: { role: string }) => message.role)).toEqual([
		"user",
		"user",
		"system",
	]);
});
it("uses billed accounting on Anthropic-compatible OpenRouter streams", async () => {
	const result = await stream({ ...model, provider: "openrouter" }, context, {
		apiKey: "offline",
		fetch: async () =>
			response([
				start,
				{
					...stop,
					usage: { ...stop.usage, cost: 0.12, is_byok: true, cost_details: { upstream_inference_cost: 0.38 } },
				},
				end,
			]),
	}).result();
	expect(result.stopReason).toBe("stop");
	expect(result.usage.cost.total).toBe(0.5);
	expect(result.usage.cost.totalFromProvider).toBe(true);
});

it("retains the existing Anthropic protocol and compatible temperature forwarding after SDK upgrades", async () => {
	let headers: Headers | undefined;
	let body: Record<string, unknown> = {};
	const result = await stream(model, context, {
		apiKey: "test",
		temperature: 0.7,
		fetch: async (_url, init) => {
			headers = new Headers(init?.headers);
			body = JSON.parse(String(init?.body));
			return answer();
		},
	}).result();
	expect(result.stopReason).toBe("stop");
	expect(headers?.get("anthropic-version")).toBe("2023-06-01");
	expect(body.temperature).toBe(0.7);
});
