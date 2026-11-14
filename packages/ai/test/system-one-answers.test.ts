import { expect, test } from "vitest";
import { classify } from "../src/api/typesafe-system-one.ts";
import type { ClassifierContext, ClassifierModel } from "../src/types.ts";

const model: ClassifierModel<"typesafe-system-one"> = {
	type: "classifier",
	api: "typesafe-system-one",
	id: "test",
	provider: "local",
	name: "Local",
	baseUrl: "https://offline.invalid",
	input: ["text"],
	contextWindow: 1000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const context: ClassifierContext = {
	state: {},
	questions: {
		pick: { type: "choice", instructions: "Choose", criteria: { one: "First", two: "Second" } },
		rank: { type: "score", instructions: "Rank", criteria: ["Low", "Middle", "High"] },
		ok: { type: "bool", instructions: "Ready?", criteria: { true: "Ready", false: "Waiting" } },
	},
};
const answers = {
	pick: { type: "choice", choice: "two", probabilities: { one: 0.25, two: 0.75 }, confidence: 0.5 },
	rank: { type: "score", score: 1.5, confidence: 0.75 },
	ok: { type: "noul", noul: 0.8 },
};

test("System One retains named choice probabilities, fractional scores and boolean probabilities", async () => {
	const result = await classify(model, context, { apiKey: "fixture", fetch: async () => Response.json({ answers }) });
	expect(result).toMatchObject({
		stopReason: "stop",
		answers: { pick: answers.pick, rank: answers.rank, ok: { type: "bool", probability: 0.8 } },
	});
});

test.each([
	{ id: "pick", answer: null, detail: "did not return an answer" },
	{ id: "pick", answer: { type: "score" }, detail: "choice answer" },
	{ id: "pick", answer: { ...answers.pick, choice: 4 }, detail: "choice answer" },
	{ id: "pick", answer: { ...answers.pick, probabilities: [] }, detail: "invalid probabilities" },
	{ id: "pick", answer: { ...answers.pick, probabilities: { one: null } }, detail: "probability" },
	{ id: "pick", answer: { ...answers.pick, confidence: null }, detail: "confidence" },
	{ id: "rank", answer: { type: "choice" }, detail: "score answer" },
	{ id: "rank", answer: { ...answers.rank, score: "1" }, detail: "score" },
	{ id: "rank", answer: { ...answers.rank, confidence: null }, detail: "confidence" },
	{ id: "ok", answer: { type: "bool", probability: 0.8 }, detail: "bool answer" },
	{ id: "ok", answer: { type: "noul", noul: null }, detail: "probability" },
])("System One rejects a malformed $id answer without retaining partial answers", async ({ id, answer, detail }) => {
	const result = await classify(model, context, {
		apiKey: "fixture",
		fetch: async () =>
			Response.json({ answers: { ...answers, [id]: answer }, usage: { input_tokens: 2, output_tokens: 1 } }),
	});
	expect(result).toMatchObject({
		stopReason: "error",
		answers: {},
		errorMessage: expect.stringContaining(detail),
		usage: { input: 2, output: 1 },
	});
});
