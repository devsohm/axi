import { expect, test } from "vitest";
import { classify } from "../src/api/llama-cpp-classify.ts";
import type { ClassifierContext, ClassifierModel, FetchFunction } from "../src/types.ts";

function model(id: string): ClassifierModel<"llama-cpp-classify"> {
	return {
		type: "classifier",
		api: "llama-cpp-classify",
		provider: "local",
		id,
		name: id,
		baseUrl: `https://${id}.invalid/v1`,
		input: ["text"],
		contextWindow: 4096,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}
const questions: ClassifierContext["questions"] = {
	ok: { type: "bool", instructions: "Ready?", criteria: { true: "Ready", false: "Waiting" } },
	rank: { type: "score", instructions: "How ready?", criteria: ["Low", "Middle", "High"] },
	pick: { type: "choice", instructions: "Choose", criteria: { one: "First", two: "Second" } },
};
const tokenIds: Record<string, number> = { Yes: 100, No: 101, "0": 48, "1": 49, "2": 50, A: 65, B: 66 };
function transport(completion: (body: Record<string, unknown>) => Response, failToken?: () => boolean): FetchFunction {
	return async (url, init) => {
		const path = new URL(String(url)).pathname,
			body = JSON.parse(String(init?.body));
		if (path === "/tokenize") {
			if (failToken?.()) return new Response("Tokenization refused", { status: 400 });
			const text = String(body.content),
				label = text.startsWith("\n") ? text.slice(1) : text;
			return Response.json({
				tokens: text === "\n" ? [10] : text.startsWith("\n") ? [10, tokenIds[label]] : [tokenIds[label]],
			});
		}
		if (path === "/apply-template") return Response.json({ prompt: "ready<think>" });
		expect(path).toBe("/completion");
		expect(body.prompt).toBe("ready<think></think>");
		return completion(body);
	};
}
function ranks(ids: number[], probabilities: number[]): Response {
	return Response.json({
		completion_probabilities: [
			{ top_logprobs: ids.map((id, index) => ({ id, logprob: Math.log(probabilities[index]!) })) },
		],
	});
}

test("llama classification returns named boolean, ordinal and choice answers in one request sequence", async () => {
	let completion = 0;
	const fetch = transport(() =>
		[
			() => ranks([100, 101], [0.8, 0.2]),
			() => ranks([48, 49, 50], [0.2, 0.3, 0.5]),
			() => ranks([65, 66], [0.25, 0.75]),
		][completion++]!(),
	);
	const result = await classify(
		model("complete-labels"),
		{ state: { status: "ready" }, questions },
		{ fetch, maxRetries: 0 },
	);
	expect(result.stopReason).toBe("stop");
	expect(result.answers.ok).toEqual({ type: "bool", probability: 0.8 });
	const rank = result.answers.rank;
	expect(rank).toMatchObject({ type: "score", confidence: 0.25 });
	if (rank?.type !== "score") throw new Error("Ordinal answer was not returned");
	expect(rank.score).toBeCloseTo(1.3, 12);
	expect(result.answers.pick).toEqual({
		type: "choice",
		choice: "two",
		probabilities: { one: expect.closeTo(0.25, 12), two: expect.closeTo(0.75, 12) },
		confidence: expect.closeTo(0.5, 12),
	});
	expect(completion).toBe(3);
});

test("failed token discovery is retried on the next classification rather than cached permanently", async () => {
	let refused = true;
	const selected = model("token-recovery"),
		fetch = transport(
			() => ranks([65, 66], [0.75, 0.25]),
			() => refused,
		);
	const context: ClassifierContext = { state: {}, questions: { pick: questions.pick! } };
	expect(await classify(selected, context, { fetch, maxRetries: 0 })).toMatchObject({
		stopReason: "error",
		answers: {},
		errorMessage: expect.stringContaining("Tokenization refused"),
	});
	refused = false;
	expect(await classify(selected, context, { fetch, maxRetries: 0 })).toMatchObject({
		stopReason: "stop",
		answers: { pick: { choice: "one" } },
	});
});

test("a missing label expands the ranked-token search and rejects the incomplete answer", async () => {
	const depths: unknown[] = [];
	const fetch = transport((body) => {
		depths.push(body.n_probs);
		return ranks([65], [1]);
	});
	const result = await classify(
		model("missing-label"),
		{ state: {}, questions: { pick: questions.pick! } },
		{ fetch, maxRetries: 0 },
	);
	expect(depths).toEqual([256, 4096, 32768]);
	expect(result).toMatchObject({
		stopReason: "error",
		answers: {},
		errorMessage: expect.stringContaining("did not rank labels B"),
	});
});

test.each([1, 11])("a score question with %i levels fails before any transport request", async (count) => {
	let requests = 0;
	const fetch: FetchFunction = async () => {
		requests++;
		throw new Error("Unexpected request");
	};
	const result = await classify(
		model(`invalid-levels-${count}`),
		{
			state: {},
			questions: {
				rank: {
					type: "score",
					instructions: "Rank",
					criteria: Array.from({ length: count }, (_, index) => `Level ${index}`),
				},
			},
		},
		{ fetch },
	);
	expect(result).toMatchObject({
		stopReason: "error",
		answers: {},
		errorMessage: `A score question needs 2 to 10 levels, got ${count}`,
	});
	expect(requests).toBe(0);
});
