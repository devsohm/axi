import type {
	ClassifierAnswer,
	ClassifierApi,
	ClassifierContext,
	ClassifierModel,
	ClassifierOptions,
	ClassifierResult,
} from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { isRecord, parseClassifierUsage, postClassifierRequest, requiredNumber } from "./classifier-shared.ts";
export interface SystemOneWireRequest {
	state: ClassifierContext["state"];
	questions: Record<string, unknown>;
}
export interface SystemOneTransport {
	api: ClassifierApi;
	label: string;
	url(model: ClassifierModel<ClassifierApi>): URL;
	payload(model: ClassifierModel<ClassifierApi>, request: SystemOneWireRequest): unknown;
	output(body: unknown): Record<string, unknown>;
}
function answers(label: string, raw: unknown, context: ClassifierContext): Record<string, ClassifierAnswer> {
	if (!isRecord(raw)) throw new Error(`${label} returned an unexpected response`);
	return Object.fromEntries(
		Object.entries(context.questions).map(([id, question]): [string, ClassifierAnswer] => {
			const value = raw[id];
			if (!isRecord(value)) throw new Error(`${label} did not return an answer for ${id}`);
			switch (question.type) {
				case "choice": {
					if (value.type !== "choice" || typeof value.choice !== "string")
						throw new Error(`${label} did not return a choice answer for ${id}`);
					if (!isRecord(value.probabilities)) throw new Error(`${label} returned invalid probabilities for ${id}`);
					return [
						id,
						{
							type: "choice",
							choice: value.choice,
							probabilities: Object.fromEntries(
								Object.entries(value.probabilities).map(([key, probability]) => [
									key,
									requiredNumber(label, probability, `probability for ${id}.${key}`),
								]),
							),
							confidence: requiredNumber(label, value.confidence, `confidence for ${id}`),
						},
					];
				}
				case "score":
					if (value.type !== "score") throw new Error(`${label} did not return a score answer for ${id}`);
					return [
						id,
						{
							type: "score",
							score: requiredNumber(label, value.score, `score for ${id}`),
							confidence: requiredNumber(label, value.confidence, `confidence for ${id}`),
						},
					];
				case "bool":
					if (value.type !== "noul") throw new Error(`${label} did not return a bool answer for ${id}`);
					return [id, { type: "bool", probability: requiredNumber(label, value.noul, `probability for ${id}`) }];
			}
		}),
	);
}
export async function classifySystemOne(
	transport: SystemOneTransport,
	model: ClassifierModel<ClassifierApi>,
	context: ClassifierContext,
	options: ClassifierOptions | undefined,
): Promise<ClassifierResult> {
	const result: ClassifierResult = {
		api: model.api,
		provider: model.provider,
		model: model.id,
		timestamp: Date.now(),
		answers: {},
		stopReason: "stop",
	};
	try {
		if (model.api !== transport.api) throw new Error(`Unsupported classifier API: ${model.api}`);
		if (context.images?.length) throw new Error(`${transport.label} does not support image input`);
		const request = {
			state: context.state,
			questions: Object.fromEntries(
				Object.entries(context.questions).map(([id, question]) => [
					id,
					question.type === "bool" ? { ...question, type: "noul" } : question,
				]),
			),
		};
		const response = transport.output(
			await postClassifierRequest(
				transport.label,
				transport.url(model),
				model,
				transport.payload(model, request),
				options,
			),
		);
		const usage = parseClassifierUsage(response.usage, model);
		if (usage) result.usage = usage;
		result.answers = answers(transport.label, response.answers, context);
	} catch (error) {
		result.stopReason = options?.signal?.aborted ? "aborted" : "error";
		result.errorMessage = formatProviderError(normalizeProviderError(error), `${transport.label} error`);
	}
	return result;
}
