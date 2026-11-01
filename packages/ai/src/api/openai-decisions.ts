import type {
	ClassifierAnswer,
	ClassifierContext,
	ClassifierFunction,
	ClassifierQuestion,
	ClassifierResult,
} from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { isRecord, parseClassifierUsage, postClassifierRequest, requiredNumber } from "./classifier-shared.ts";
const label = "OpenAI Decisions";
function input(context: ClassifierContext): unknown {
	const text = JSON.stringify(context.state),
		images = context.images ?? [];
	if (!images.length) return text;
	if (images.length > 128) throw new Error(`${label} accepts at most 128 images, got ${images.length}`);
	return [
		{
			role: "user",
			content: [
				{ type: "input_text", text },
				...images.map((image) => ({ type: "input_image", image_url: `data:${image.mimeType};base64,${image.data}` })),
			],
		},
	];
}
function question(name: string, item: ClassifierQuestion): object {
	switch (item.type) {
		case "choice":
			return {
				type: "choice",
				name,
				instructions: item.instructions,
				choices: Object.entries(item.criteria).map(([value, description]) => ({
					value,
					...(description ? { description } : {}),
				})),
			};
		case "score":
			return {
				type: "score",
				name,
				instructions: item.instructions,
				levels: item.criteria.map((label) => ({ label })),
			};
		case "bool": {
			const meanings = [
				item.criteria.true ? `True means: ${item.criteria.true}` : "",
				item.criteria.false ? `False means: ${item.criteria.false}` : "",
			].filter(Boolean);
			return {
				type: "predicate",
				name,
				instructions: meanings.length ? `${item.instructions}\n\n${meanings.join("\n")}` : item.instructions,
			};
		}
	}
}
function answer(id: string, item: ClassifierQuestion, value: Record<string, unknown>): ClassifierAnswer {
	if (value.type === "refusal") throw new Error(`${label} refused to answer ${id}`);
	if (item.type === "choice") {
		if (value.type !== "choice" || typeof value.choice !== "string")
			throw new Error(`${label} did not return a choice answer for ${id}`);
		if (!Array.isArray(value.probabilities)) throw new Error(`${label} returned invalid probabilities for ${id}`);
		const probabilities = Object.fromEntries(
			value.probabilities.map((entry: unknown) => {
				if (!isRecord(entry) || typeof entry.value !== "string")
					throw new Error(`${label} returned invalid probabilities for ${id}`);
				return [entry.value, requiredNumber(label, entry.probability, `probability for ${id}.${entry.value}`)];
			}),
		);
		return {
			type: "choice",
			choice: value.choice,
			probabilities,
			confidence: requiredNumber(label, value.confidence, `confidence for ${id}`),
		};
	}
	if (item.type === "score") {
		if (value.type !== "score") throw new Error(`${label} did not return a score answer for ${id}`);
		return {
			type: "score",
			score: requiredNumber(label, value.score, `score for ${id}`),
			confidence: requiredNumber(label, value.confidence, `confidence for ${id}`),
		};
	}
	if (value.type !== "predicate") throw new Error(`${label} did not return a predicate answer for ${id}`);
	return { type: "bool", probability: requiredNumber(label, value.probability, `probability for ${id}`) };
}
export const classify: ClassifierFunction = async (model, context, options) => {
	const result: ClassifierResult = {
		api: model.api,
		provider: model.provider,
		model: model.id,
		timestamp: Date.now(),
		answers: {},
		stopReason: "stop",
	};
	try {
		if (model.api !== "openai-decisions") throw new Error(`Unsupported classifier API: ${model.api}`);
		const body = await postClassifierRequest(
			label,
			new URL("decisions", `${model.baseUrl.replace(/\/+$/u, "")}/`),
			model,
			{
				model: model.id,
				input: input(context),
				questions: Object.entries(context.questions).map(([name, item]) => question(name, item)),
			},
			options,
			[504],
		);
		if (!isRecord(body)) throw new Error(`${label} returned an unexpected response`);
		const usage = parseClassifierUsage(body.usage, model);
		if (usage) result.usage = usage;
		if (!Array.isArray(body.answers)) throw new Error(`${label} returned an unexpected response`);
		const named = new Map<string, Record<string, unknown>>();
		for (const entry of body.answers)
			if (isRecord(entry) && typeof entry.name === "string") named.set(entry.name, entry);
		result.answers = Object.fromEntries(
			Object.entries(context.questions).map(([id, item]) => {
				const value = named.get(id);
				if (!value) throw new Error(`${label} did not return an answer for ${id}`);
				return [id, answer(id, item, value)];
			}),
		);
	} catch (error) {
		result.answers = {};
		result.stopReason = options?.signal?.aborted ? "aborted" : "error";
		if (error === null || error === undefined)
			throw new TypeError(`Cannot read properties of ${String(error)} (reading 'status')`);
		const status: unknown = Reflect.get(Object(error), "status");
		result.errorMessage =
			status === 504
				? `${label} error (504): the request timed out at the gateway. Very large inputs (above roughly 600K tokens) currently exceed its time limit.`
				: formatProviderError(normalizeProviderError(error), `${label} error`);
	}
	return result;
};
