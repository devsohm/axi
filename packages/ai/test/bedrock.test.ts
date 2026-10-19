import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConverseStreamCommandInput } from "@aws-sdk/client-bedrock-runtime";
import { Type } from "typebox";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";
type Middleware = (next: (args: unknown) => Promise<unknown>) => (args: unknown) => Promise<unknown>;
const sdk = vi.hoisted(() => ({
	configs: [] as Record<string, unknown>[],
	requests: [] as unknown[],
	middleware: [] as { handler: Middleware; options: { step: string; name: string } }[],
	send: vi.fn(),
}));
vi.mock("@aws-sdk/client-bedrock-runtime", async (importOriginal) => {
	const original = await importOriginal<typeof import("@aws-sdk/client-bedrock-runtime")>();
	return {
		...original,
		BedrockRuntimeClient: class {
			constructor(config: Record<string, unknown>) {
				sdk.configs.push(config);
			}
			middlewareStack = {
				add: (handler: Middleware, options: { step: string; name: string }) =>
					sdk.middleware.push({ handler, options }),
			};
			send(command: { input: unknown }) {
				sdk.requests.push(command.input);
				return sdk.send();
			}
		},
	};
});
import { BedrockRuntimeServiceException } from "@aws-sdk/client-bedrock-runtime";
import { stream, streamSimple, type BedrockOptions } from "../src/api/bedrock-converse-stream.ts";
const model: Model<"bedrock-converse-stream"> = {
	api: "bedrock-converse-stream",
	provider: "bedrock",
	id: "us.anthropic.claude-opus-4-8",
	name: "Claude Opus 4.8",
	baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
	reasoning: true,
	input: ["text", "image"],
	contextWindow: 100000,
	maxTokens: 8192,
	cost: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 3 },
	compat: { supportsStrictMode: true },
};
const context = normalizeContext({
	systemPrompt: "Be precise",
	messages: [{ role: "user", content: "hello", timestamp: 0 }],
});
function response(events: object[]) {
	return {
		$metadata: { httpStatusCode: 200, requestId: "request-1" },
		stream: (async function* () {
			yield* events;
		})(),
	};
}
beforeEach(() => {
	sdk.configs.length = sdk.requests.length = sdk.middleware.length = 0;
	sdk.send
		.mockReset()
		.mockImplementation(async () =>
			response([
				{ messageStart: { role: "assistant" } },
				{ contentBlockDelta: { contentBlockIndex: 0, delta: { text: "answer" } } },
				{ contentBlockStop: { contentBlockIndex: 0 } },
				{ messageStop: { stopReason: "end_turn" } },
			]),
		);
});
afterEach(() => vi.unstubAllEnvs());
async function payload(m = model, options: BedrockOptions = {}): Promise<ConverseStreamCommandInput> {
	let captured: ConverseStreamCommandInput | undefined;
	await stream(m, context, {
		...options,
		onPayload: (value) => {
			captured = value as ConverseStreamCommandInput;
			throw new Error("captured");
		},
	}).result();
	if (!captured) throw new Error("Request was not built");
	return captured;
}
describe("Bedrock adapter", () => {
	it("exposes active tool input and removes scratch fields at block completion", async () => {
		const frames = [
			{ messageStart: { role: "assistant" } },
			{ contentBlockStart: { contentBlockIndex: 7, start: { toolUse: { toolUseId: "call-1", name: "read" } } } },
			{ contentBlockDelta: { contentBlockIndex: 7, delta: { toolUse: { input: '{"path":"file"}' } } } },
			{ contentBlockStop: { contentBlockIndex: 7 } },
			{ messageStop: { stopReason: "tool_use" } },
		];
		sdk.send.mockResolvedValue({
			$metadata: { httpStatusCode: 200 },
			stream: (async function* () {
				for (const frame of frames) {
					await new Promise((resolve) => setImmediate(resolve));
					yield frame;
				}
			})(),
		});
		const snapshots = [];
		for await (const event of stream(model, context))
			if (event.type === "toolcall_start" || event.type === "toolcall_delta" || event.type === "toolcall_end")
				snapshots.push(structuredClone(event.partial.content[0]));
		expect(snapshots).toEqual([
			{ type: "toolCall", id: "call-1", name: "read", arguments: {}, partialJson: "", index: 7 },
			{
				type: "toolCall",
				id: "call-1",
				name: "read",
				arguments: { path: "file" },
				partialJson: '{"path":"file"}',
				index: 7,
			},
			{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "file" } },
		]);
	});
	it("preserves profile precedence, bearer authentication and ARN region routing", async () => {
		vi.stubEnv("AWS_ACCESS_KEY_ID", "ambient");
		vi.stubEnv("AWS_SECRET_ACCESS_KEY", "ambient-secret");
		await stream(model, context, { profile: "explicit", apiKey: "bearer", region: "eu-west-1" }).result();
		expect(sdk.configs[0]).toEqual({
			profile: "explicit",
			region: "eu-west-1",
			token: { token: "bearer" },
			authSchemePreference: ["httpBearerAuth"],
		});
		await stream(
			{
				...model,
				id: "arn:aws-us-gov:bedrock:us-gov-west-1:1:application-inference-profile/id",
				baseUrl: "https://proxy.invalid",
			},
			context,
			{ env: { AWS_PROFILE: "scoped" }, region: "eu-west-1" },
		).result();
		expect(sdk.configs[1]).toEqual({ profile: "scoped", endpoint: "https://proxy.invalid", region: "us-gov-west-1" });
	});
	it("selects adaptive and budget reasoning while respecting GovCloud restrictions", async () => {
		expect((await payload(model, { reasoning: "xhigh" })).additionalModelRequestFields).toEqual({
			thinking: { type: "adaptive", display: "summarized", block_binding: { prefix_mismatch_behavior: "drop_block" } },
			output_config: { effort: "xhigh" },
			anthropic_beta: ["thinking-binding-controls-2026-08-01"],
		});
		expect(
			(await payload(model, { reasoning: "medium", region: "us-gov-east-1" })).additionalModelRequestFields,
		).toEqual({ thinking: { type: "adaptive" }, output_config: { effort: "medium" } });
		expect(
			(
				await payload(
					{ ...model, id: "us.anthropic.claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
					{ reasoning: "high", thinkingBudgets: { high: 3000 }, interleavedThinking: false },
				)
			).additionalModelRequestFields,
		).toEqual({ thinking: { type: "enabled", budget_tokens: 3000, display: "summarized" } });
		expect(
			(await payload({ ...model, id: "global.openai.gpt-6-sol", name: "GPT-6" }, { reasoning: "max" }))
				.additionalModelRequestFields,
		).toEqual({ reasoning: { effort: "max" } });
	});
	it("keeps raw callbacks ordered and bills cache writes at their recorded retention", async () => {
		const frames = [
			{ messageStart: { role: "assistant" } },
			{ contentBlockDelta: { contentBlockIndex: 0, delta: { text: "answer" } } },
			{
				metadata: {
					usage: {
						inputTokens: 100,
						outputTokens: 20,
						cacheWriteInputTokens: 1000000,
						cacheReadInputTokens: 10,
						totalTokens: 1000130,
						cacheDetails: [
							{ ttl: "1h", inputTokens: 400000 },
							{ ttl: "5m", inputTokens: 600000 },
						],
					},
				},
			},
			{ messageStop: { stopReason: "end_turn" } },
		];
		sdk.send.mockResolvedValue(response(frames));
		const received: unknown[] = [],
			responses: unknown[] = [];
		const result = await stream(model, context, {
			onResponse: (value) => {
				responses.push(value);
			},
			onProviderStreamEvent: (item) => {
				received.push(item);
			},
		}).result();
		expect(received).toEqual(frames);
		expect(received[0]).toBe(frames[0]);
		expect(responses).toEqual([{ status: 200, headers: { "x-amzn-requestid": "request-1" } }]);
		expect(result).toMatchObject({
			stopReason: "stop",
			content: [{ type: "text", text: "answer" }],
			usage: { cacheWrite: 1000000, cacheWrite1h: 400000, totalTokens: 1000130 },
		});
		expect(result.usage.cost.cacheWrite).toBeCloseTo(3.4, 12);
	});
	it("joins redacted bytes even when a stream fails before its block stop", async () => {
		sdk.send.mockResolvedValue({
			$metadata: { httpStatusCode: 200, requestId: "request-1" },
			stream: (async function* () {
				yield { messageStart: { role: "assistant" } };
				yield {
					contentBlockDelta: {
						contentBlockIndex: 0,
						delta: { reasoningContent: { redactedContent: new Uint8Array([1, 2]) } },
					},
				};
				yield {
					contentBlockDelta: {
						contentBlockIndex: 0,
						delta: { reasoningContent: { redactedContent: new Uint8Array([3, 4]) } },
					},
				};
				throw new Error("disconnected");
			})(),
		});
		const result = await stream(model, context).result();
		expect(result.content).toEqual([
			{ type: "thinking", thinking: "[Reasoning redacted]", thinkingSignature: "AQIDBA==", redacted: true },
		]);
		expect(result).toMatchObject({
			stopReason: "error",
			errorMessage: "disconnected",
			diagnostics: [{ type: "bedrock_response_failure", details: { requestId: "request-1" } }],
		});
	});
	it("records provider failure metadata without treating transport names as provider codes", async () => {
		sdk.send.mockRejectedValue(
			new BedrockRuntimeServiceException({
				name: "ValidationException",
				message: "invalid",
				$fault: "client",
				$metadata: { httpStatusCode: 400, requestId: "request-2" },
			}),
		);
		const result = await stream(model, context).result();
		expect(result).toMatchObject({
			stopReason: "error",
			errorMessage: "Validation error: invalid",
			diagnostics: [
				{
					type: "bedrock_response_failure",
					details: { status: 400, errorCode: "ValidationException", requestId: "request-2" },
				},
			],
		});
		sdk.send.mockRejectedValue(new Error("network failed"));
		expect((await stream(model, context).result()).diagnostics).toBeUndefined();
	});
	it("retains request correlation when the fallback response callback throws", async () => {
		const result = await stream(model, context, {
			onResponse: () => {
				throw new Error("callback failed");
			},
		}).result();
		expect(result).toMatchObject({
			stopReason: "error",
			errorMessage: "callback failed",
			diagnostics: [{ type: "bedrock_response_failure", details: { requestId: "request-1" } }],
		});
	});
	it("protects signing headers while forwarding allowed headers through simple mode", async () => {
		await streamSimple(model, context, {
			headers: { authorization: "bad", "X-Amz-Date": "bad", HOST: "bad", "x-custom": "yes" },
		}).result();
		const registration = sdk.middleware.find((row) => row.options.step === "build");
		if (!registration) throw new Error("No build middleware");
		const args = { request: { headers: { authorization: "signed", host: "real" } } };
		await registration.handler(async (value: unknown) => value)(args);
		expect(args.request.headers).toEqual({ authorization: "signed", host: "real", "x-custom": "yes" });
	});
	it("sends strict tool schemas and excludes tools when requested", async () => {
		const toolContext = normalizeContext({
			...context,
			tools: [
				{
					name: "read",
					description: "Read",
					parameters: Type.Object({ path: Type.String() }),
					constrainedSampling: { type: "json_schema", strict: "require" },
				},
			],
		});
		await stream(model, toolContext, {
			toolChoice: "any",
			requestMetadata: { run: "one" },
			cacheRetention: "long",
		}).result();
		expect(sdk.requests[0]).toMatchObject({
			toolConfig: { tools: [{ toolSpec: { strict: true } }], toolChoice: { any: {} } },
			system: [{ text: "Be precise" }, { cachePoint: { type: "default", ttl: "1h" } }],
			requestMetadata: { run: "one" },
		});
		await stream(model, toolContext, { toolChoice: "none" }).result();
		expect((sdk.requests[1] as ConverseStreamCommandInput).toolConfig).toBeUndefined();
	});
});
