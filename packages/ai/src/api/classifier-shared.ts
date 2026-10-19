import { calculateCost } from "../models.ts";
import type { ClassifierApi, ClassifierModel, ClassifierOptions, Usage } from "../types.ts";
import { classifierJson } from "../internal/classifier-request.ts";
export interface ClassifierHttpError extends Error {
	status: number | undefined;
	headers: Headers | undefined;
	body: string;
}
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function requiredNumber(label: string, value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} returned an invalid ${field}`);
	return value;
}
export async function postClassifierRequest(
	label: string,
	url: URL,
	model: ClassifierModel<ClassifierApi>,
	body: unknown,
	options: ClassifierOptions | undefined,
	noRetryStatuses?: readonly number[],
): Promise<unknown> {
	if (!options?.apiKey) throw new Error(`No API key for provider: ${model.provider}`);
	return classifierJson({ label, url, model, body, options, apiKey: options.apiKey, noRetryStatuses, observe: true });
}
export function parseClassifierUsage(value: unknown, model: ClassifierModel<ClassifierApi>): Usage | undefined {
	if (!isRecord(value) || (value.input_tokens === undefined && value.output_tokens === undefined)) return undefined;
	const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
	const input = count(value.input_tokens),
		output = count(value.output_tokens);
	const usage: Usage = {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	calculateCost(model, usage);
	return usage;
}
