import type {
	ClassifierAnswer,
	ClassifierApi,
	ClassifierContext,
	ClassifierModel,
	ClassifierOptions,
	ClassifierResult,
	SystemOneCompat,
} from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { isRecord, parseClassifierUsage, postClassifierRequest, requiredNumber } from "./classifier-shared.ts";
export interface SystemOneWireRequest {
	state: unknown;
	questions: Record<string, unknown>;
	assets?: Record<string, { type: "image"; format: "png" | "jpeg"; data_base64: string }>;
	images?: string[];
}
export type SystemOneImageInput = NonNullable<SystemOneCompat["imageInput"]>;
export type ResolvedSystemOneCompat = Required<SystemOneCompat>;
export interface SystemOneTransport {
	api: ClassifierApi;
	label: string;
	detectCompat(model: ClassifierModel<ClassifierApi>): ResolvedSystemOneCompat;
	url(model: ClassifierModel<ClassifierApi>): URL;
	payload(model: ClassifierModel<ClassifierApi>, request: SystemOneWireRequest): unknown;
	output(body: unknown): Record<string, unknown>;
}
function withImages(
	request: SystemOneWireRequest,
	context: ClassifierContext,
	model: ClassifierModel<ClassifierApi>,
	transport: SystemOneTransport,
	options: ClassifierOptions | undefined,
): ClassifierOptions | undefined {
	const images = context.images;
	if (!images?.length) return options;
	const label = transport.label;
	if (!model.input.includes("image")) throw new Error(`${label} does not support image input for ${model.id}`);
	const defaults = transport.detectCompat(model);
	const encoding = model.compat?.imageInput ?? defaults.imageInput;
	const dataUrl = (image: (typeof images)[number]) => `data:${image.mimeType};base64,${image.data}`;
	switch (encoding) {
		case "state-image-urls":
			request.state = [
				...images.map((image) => ({ type: "image_url", image_url: { url: dataUrl(image) } })),
				request.state,
			];
			break;
		case "images":
			if (images.length > 4) throw new Error(`${label} accepts at most 4 images for ${model.id}, got ${images.length}`);
			request.images = images.map((image) => {
				if (!["image/png", "image/jpeg", "image/webp"].includes(image.mimeType))
					throw new Error(`${label} accepts PNG, JPEG, and WebP images for ${model.id}, got ${image.mimeType}`);
				return dataUrl(image);
			});
			break;
		case "assets": {
			const assets: NonNullable<SystemOneWireRequest["assets"]> = {};
			for (const [index, image] of images.entries()) {
				if (image.mimeType !== "image/png" && image.mimeType !== "image/jpeg")
					throw new Error(`${label} accepts PNG and JPEG images for ${model.id}, got ${image.mimeType}`);
				assets[`<image-${index + 1}>`] = {
					type: "image",
					format: image.mimeType === "image/png" ? "png" : "jpeg",
					data_base64: image.data,
				};
			}
			request.assets = assets;
			request.state = [...Object.keys(assets), request.state];
			break;
		}
	}
	return (model.compat?.sendImageOptInHeader ?? defaults.sendImageOptInHeader)
		? { ...options, headers: { "TypeSafe-Danger-Zone-Images": "true", ...options?.headers } }
		: options;
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
		const request: SystemOneWireRequest = {
			state: context.state,
			questions: Object.fromEntries(
				Object.entries(context.questions).map(([id, question]) => [
					id,
					question.type === "bool" ? { ...question, type: "noul" } : question,
				]),
			),
		};
		const requestOptions = withImages(request, context, model, transport, options);
		const response = transport.output(
			await postClassifierRequest(
				transport.label,
				transport.url(model),
				model,
				transport.payload(model, request),
				requestOptions,
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
