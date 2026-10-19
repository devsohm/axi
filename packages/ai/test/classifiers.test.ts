import { describe, expect, it } from "vitest";
import { classify as systemOne } from "../src/api/typesafe-system-one.ts";
import { classify as cloudflare } from "../src/api/cloudflare-workers-ai-system-one.ts";
import { cloudflareWorkersAISystemOneApi } from "../src/api/cloudflare-workers-ai-system-one.lazy.ts";
import { classify as decisions } from "../src/api/openai-decisions.ts";
import { classify as llama } from "../src/api/llama-cpp-classify.ts";
import { envApiKeyAuth } from "../src/auth/helpers.ts";
import { createModels, createProvider } from "../src/models.ts";
import type { ClassifierApi, ClassifierContext, ClassifierModel, ClassifierOptions } from "../src/types.ts";
const context: ClassifierContext = {
	state: { message: "approved" },
	questions: { ok: { type: "bool", instructions: "Approved?", criteria: { true: "Approval", false: "No approval" } } },
};
function model<A extends ClassifierApi>(api: A): ClassifierModel<A> {
	return {
		type: "classifier",
		api,
		provider: "classifiers",
		id: "test",
		name: "Test",
		baseUrl: "https://provider.invalid/v1/",
		input: ["text", "image"],
		contextWindow: 100000,
		cost: {
			input: 2,
			output: 8,
			cacheRead: 0,
			cacheWrite: 0,
			tiers: [{ inputTokensAbove: 200, input: 4, output: 16, cacheRead: 0, cacheWrite: 0 }],
		},
	};
}

describe("Classifier protocols", () => {
	it("reads the llama request key after selecting its fetch implementation", async () => {
		const keys: Array<string | null> = [];
		const fetch: typeof globalThis.fetch = async (url, init) => {
			keys.push(new Headers(init?.headers).get("authorization"));
			const path = new URL(String(url)).pathname,
				body = JSON.parse(String(init?.body));
			if (path === "/tokenize")
				return Response.json({ tokens: [...String(body.content)].map((char) => char.charCodeAt(0)) });
			if (path === "/apply-template") return Response.json({ prompt: "ready" });
			return Response.json({
				completion_probabilities: [
					{
						top_logprobs: [
							{ id: 65, logprob: 0 },
							{ id: 66, logprob: -1 },
						],
					},
				],
			});
		};
		const options: ClassifierOptions = {
			apiKey: "before",
			get fetch() {
				options.apiKey = "after";
				return fetch;
			},
		};
		const result = await llama(
			{ ...model("llama-cpp-classify"), baseUrl: "https://fetch-selection.invalid/v1" },
			{
				state: {},
				questions: { pick: { type: "choice", instructions: "Pick", criteria: { one: "First", two: "Second" } } },
			},
			options,
		);
		expect(keys).toEqual(Array(6).fill("Bearer after"));
		expect(result.stopReason).toBe("stop");
	});

	it("keeps llama request headers through a retry", async () => {
		const headers: Array<string | null> = [];
		const options: ClassifierOptions = {
			headers: { "x-attempt": "initial" },
			fetch: async (url, init) => {
				const path = new URL(String(url)).pathname,
					body = JSON.parse(String(init?.body));
				if (path === "/tokenize")
					return Response.json({ tokens: [...String(body.content)].map((char) => char.charCodeAt(0)) });
				if (path === "/apply-template") return Response.json({ prompt: "ready" });
				headers.push(new Headers(init?.headers).get("x-attempt"));
				if (headers.length === 1) {
					options.headers = { "x-attempt": "changed" };
					return new Response("retry", { status: 429, headers: { "retry-after-ms": "0" } });
				}
				return Response.json({
					completion_probabilities: [
						{
							top_logprobs: [
								{ id: 65, logprob: Math.log(0.75) },
								{ id: 66, logprob: Math.log(0.25) },
							],
						},
					],
				});
			},
		};
		const result = await llama(
			{ ...model("llama-cpp-classify"), baseUrl: "https://retry-headers.invalid/v1" },
			{
				state: {},
				questions: { pick: { type: "choice", instructions: "Pick", criteria: { one: "First", two: "Second" } } },
			},
			options,
		);
		expect(headers).toEqual(["initial", "initial"]);
		expect(result.stopReason).toBe("stop");
		expect(result.answers.pick).toMatchObject({ type: "choice", choice: "one", probabilities: { two: 0.25 } });
	});
	it("retains the selected key when the payload callback changes request options", async () => {
		let authorization: string | null = null;
		const options: ClassifierOptions = {
			apiKey: "initial",
			onPayload: () => {
				options.apiKey = "changed";
			},
			fetch: async (_url, init) => {
				authorization = new Headers(init?.headers).get("authorization");
				return Response.json({ answers: { ok: { type: "noul", noul: 0.75 } } });
			},
		};
		const result = await systemOne(model("typesafe-system-one"), context, options);
		expect({ authorization, answer: result.answers.ok, stopReason: result.stopReason }).toEqual({
			authorization: "Bearer initial",
			answer: { type: "bool", probability: 0.75 },
			stopReason: "stop",
		});
	});
	it("runs Cloudflare classification through the model runtime and parses both REST envelopes", async () => {
		const selected = model("cloudflare-workers-ai-system-one"),
			models = createModels();
		models.setProvider(
			createProvider({
				id: "classifiers",
				models: [selected],
				auth: { apiKey: envApiKeyAuth("Classifier key", []) },
				classifiers: { "cloudflare-workers-ai-system-one": cloudflareWorkersAISystemOneApi() },
			}),
		);
		const requests: unknown[] = [];
		for (const wrapped of [true, false]) {
			const result = await models.classify(selected, context, {
				apiKey: "test",
				fetch: async (url, init) => {
					requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
					const output = {
						answers: { ok: { type: "noul", noul: 0.9 } },
						usage: { input_tokens: 300, output_tokens: 10 },
					};
					return Response.json({ success: true, result: wrapped ? { state: "Completed", result: output } : output });
				},
			});
			expect(result).toMatchObject({
				stopReason: "stop",
				answers: { ok: { type: "bool", probability: 0.9 } },
				usage: { input: 300, output: 10, totalTokens: 310 },
			});
			expect(result.usage?.cost.total).toBeCloseTo(0.00136, 12);
		}
		expect(requests).toEqual(
			Array.from({ length: 2 }, () => ({
				url: "https://provider.invalid/v1/run",
				body: {
					model: "test",
					input: {
						state: { message: "approved" },
						questions: {
							ok: { type: "noul", instructions: "Approved?", criteria: { true: "Approval", false: "No approval" } },
						},
					},
				},
			})),
		);
	});
	it("reports Cloudflare service errors and incomplete runs", async () => {
		const failed = await cloudflare(model("cloudflare-workers-ai-system-one"), context, {
			apiKey: "test",
			fetch: async () => Response.json({ success: false, errors: [{ message: "denied" }, { message: "no model" }] }),
		});
		const queued = await cloudflare(model("cloudflare-workers-ai-system-one"), context, {
			apiKey: "test",
			fetch: async () => Response.json({ success: true, result: { state: "Queued" } }),
		});
		expect(failed).toMatchObject({
			stopReason: "error",
			errorMessage: "Cloudflare Workers AI error: denied; no model",
		});
		expect(queued).toMatchObject({
			stopReason: "error",
			errorMessage: "Cloudflare Workers AI run did not complete (state: Queued)",
		});
	});
	it("keeps billed usage when answers are malformed and preserves prototype-sensitive IDs", async () => {
		const selected = model("typesafe-system-one");
		const failed = await systemOne(selected, context, {
			apiKey: "test",
			fetch: async () =>
				Response.json({
					answers: { ok: { type: "noul", noul: "invalid" } },
					usage: { input_tokens: 10, output_tokens: 2 },
				}),
		});
		expect(failed).toMatchObject({
			stopReason: "error",
			errorMessage: "System One API returned an invalid probability for ok",
			answers: {},
			usage: { input: 10, output: 2 },
		});
		const proto = await systemOne(
			selected,
			{ state: {}, questions: Object.fromEntries([["__proto__", context.questions.ok]]) },
			{
				apiKey: "test",
				fetch: async () =>
					Response.json({ answers: Object.fromEntries([["__proto__", { type: "noul", noul: 0.75 }]]) }),
			},
		);
		expect(proto.stopReason).toBe("stop");
		expect(Object.hasOwn(proto.answers, "__proto__")).toBe(true);
		expect(JSON.stringify(proto.answers)).toBe('{"__proto__":{"type":"bool","probability":0.75}}');
	});
	it("maps Decisions predicates and images while preserving usage on refusal", async () => {
		let body = "";
		const result = await decisions(
			model("openai-decisions"),
			{ ...context, images: [{ type: "image", mimeType: "image/png", data: "AA==" }] },
			{
				apiKey: "test",
				fetch: async (_url, init) => {
					body = String(init?.body);
					return Response.json({ answers: [{ type: "refusal", name: "ok" }], usage: { input_tokens: 20 } });
				},
			},
		);
		expect(JSON.parse(body)).toEqual({
			model: "test",
			input: [
				{
					role: "user",
					content: [
						{ type: "input_text", text: '{"message":"approved"}' },
						{ type: "input_image", image_url: "data:image/png;base64,AA==" },
					],
				},
			],
			questions: [
				{ type: "predicate", name: "ok", instructions: "Approved?\n\nTrue means: Approval\nFalse means: No approval" },
			],
		});
		expect(result).toMatchObject({
			stopReason: "error",
			errorMessage: "OpenAI Decisions refused to answer ok",
			answers: {},
			usage: { input: 20, totalTokens: 20 },
		});
	});
	it("does not retry Decisions gateway timeouts", async () => {
		let requests = 0;
		const result = await decisions(model("openai-decisions"), context, {
			apiKey: "test",
			fetch: async () => {
				requests++;
				return new Response("<html>timeout</html>", { status: 504, headers: { "retry-after-ms": "0" } });
			},
		});
		expect(result).toMatchObject({
			stopReason: "error",
			errorMessage: expect.stringContaining("OpenAI Decisions error (504): the request timed out at the gateway"),
		});
		expect(requests).toBe(1);
	});
	it.each(["fetch", "onPayload"] as const)("rejects absent failures from the Decisions %s callback", async (where) => {
		for (const failure of [null, undefined]) {
			const options: ClassifierOptions = { apiKey: "test", maxRetries: 0 };
			options[where] = async () => {
				throw failure;
			};
			await expect(decisions(model("openai-decisions"), context, options)).rejects.toThrow(
				new TypeError(`Cannot read properties of ${String(failure)} (reading 'status')`),
			);
		}
	});
	it("recognizes Decisions gateway statuses on callable and array failures", async () => {
		for (const failure of [Object.assign(() => {}, { status: 504 }), Object.assign([], { status: 504 })]) {
			const result = await decisions(model("openai-decisions"), context, {
				apiKey: "test",
				maxRetries: 0,
				fetch: async () => {
					throw failure;
				},
			});
			expect(result).toMatchObject({
				stopReason: "error",
				errorMessage:
					"OpenAI Decisions error (504): the request timed out at the gateway. Very large inputs (above roughly 600K tokens) currently exceed its time limit.",
			});
		}
	});
	it("distinguishes per-request timeout from caller cancellation", async () => {
		const timeout = await systemOne(model("typesafe-system-one"), context, {
			apiKey: "test",
			timeoutMs: 5,
			maxRetries: 0,
			fetch: async (_url, init) =>
				new Promise<Response>((_resolve, reject) =>
					init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }),
				),
		});
		expect(timeout).toMatchObject({ stopReason: "error", errorMessage: "Request timed out after 5ms" });
		const controller = new AbortController();
		controller.abort();
		const cancelled = await systemOne(model("typesafe-system-one"), context, {
			apiKey: "test",
			signal: controller.signal,
			fetch: async (_url, init) => {
				init?.signal?.throwIfAborted();
				return Response.json({});
			},
		});
		expect(cancelled).toMatchObject({ stopReason: "aborted", errorMessage: expect.stringMatching(/abort/i) });
	});
	it("reads llama label probabilities, escalates incomplete readouts and reuses label tokenization", async () => {
		const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
		const selected = { ...model("llama-cpp-classify"), baseUrl: "https://own-classifier.invalid/v1/" };
		const questions: ClassifierContext["questions"] = {
			pick: { type: "choice", instructions: "Pick one", criteria: { one: "First", two: "Second" } },
		};
		const fetch: typeof globalThis.fetch = async (url, init) => {
			const path = new URL(String(url)).pathname,
				body = JSON.parse(String(init?.body));
			requests.push({ path, body });
			if (path === "/tokenize")
				return Response.json({ tokens: [...String(body.content)].map((char) => char.charCodeAt(0)) });
			if (path === "/apply-template") return Response.json({ prompt: "<think>" });
			return Response.json({
				completion_probabilities: [
					{
						top_logprobs:
							Number(body.n_probs) < 4096
								? [{ id: 65, logprob: Math.log(0.75) }]
								: [
										{ id: 65, logprob: Math.log(0.75) },
										{ id: 66, logprob: Math.log(0.25) },
									],
					},
				],
			});
		};
		for (let call = 0; call < 2; call++) {
			const result = await llama(selected, { state: {}, questions }, { fetch });
			expect(result.stopReason).toBe("stop");
			const answer = result.answers.pick;
			expect(answer.type).toBe("choice");
			if (answer.type !== "choice") throw new Error("Expected choice");
			expect(answer.choice).toBe("one");
			expect(answer.probabilities.one).toBeCloseTo(0.75);
			expect(answer.probabilities.two).toBeCloseTo(0.25);
			expect(answer.confidence).toBeCloseTo(0.5);
		}
		expect(requests.filter((request) => request.path === "/tokenize")).toHaveLength(4);
		expect(requests.filter((request) => request.path === "/completion").map((request) => request.body.n_probs)).toEqual(
			[256, 4096, 256, 4096],
		);
		expect(requests.find((request) => request.path === "/completion")?.body.prompt).toBe("<think></think>");
	});
});
