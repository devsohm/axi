import type { AnyModel, ClassifierContext, ImagesContext, Models, ModelType, ModelTypeMap, Usage } from "@axi/ai";
import type { Context, JsonValue } from "@axi/chord";
import { Type } from "typebox";
import { defineTool } from "../harness/define.ts";
import type { ToolRegistration } from "../harness/types.ts";

export const CODEMODE_INTERNAL_PREFIX = "axi.codemode.";
export const CLASSIFY_TOOL = `${CODEMODE_INTERNAL_PREFIX}models.classify`;
export const GENERATE_IMAGES_TOOL = `${CODEMODE_INTERNAL_PREFIX}models.generateImages`;
export const MODEL_CALLS: Readonly<Record<string, string>> = {
	"models.classify": CLASSIFY_TOOL,
	"models.generateImages": GENERATE_IMAGES_TOOL,
};
export const CATALOG_GLOBALS = [
	"models.getModelsOfType",
	"models.getAvailableOfType",
	"models.getModelOfType",
] as const;
export const MAX_CONCURRENT_MODEL_CALLS = 4;
export const MODELS_DESCRIPTION = [
	"`models` (all functions return promises):",
	'- `models.getModelsOfType(type, provider?)`, `models.getAvailableOfType(type, provider?)` and `models.getModelOfType(type, provider, id)` read the catalog. Types are "chat", "image" and "classifier". Available models require configured authentication.',
	'- `models.classify(model, { state: { ... }, images?: [image blocks], questions: { id: { type: "choice" | "score" | "bool", instructions, criteria } } })` returns `{ answers, stopReason, errorMessage?, usage? }`. Choice criteria map labels to meanings. Score criteria list levels from lowest to highest. Boolean criteria have `true` and `false` meanings.',
	'- `models.generateImages(model, { input: [{ type: "text", text: <prompt> }, ...image blocks] })` returns `{ output, stopReason, errorMessage?, usage? }`. Display returned images with `image(block)`.',
	"At most 4 classify/generateImages calls run at once; more wait.",
].join("\n");

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function describe(value: unknown): string {
	if (value === null || value === undefined) return String(value);
	if (Array.isArray(value)) return value.length ? "an array" : "an empty array";
	if (typeof value === "object") {
		const keys = Object.keys(value);
		return keys.length ? `{ ${keys.slice(0, 6).join(", ")}${keys.length > 6 ? ", ..." : ""} }` : "{}";
	}
	return typeof value === "string" ? "a string" : `a ${typeof value}`;
}
const article = (word: string): string => `${/^[aeiou]/.test(word) ? "an" : "a"} ${word}`;
const modelTypes = ["chat", "image", "classifier"] as const;
function modelType(value: unknown): ModelType {
	if (value === "chat" || value === "image" || value === "classifier") return value;
	throw new Error(`Unknown model type ${JSON.stringify(value)}. Use "chat", "image", or "classifier".`);
}
function providerOf(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value === "string") return value;
	throw new Error("provider must be a string");
}
function publicModel(model: AnyModel): JsonValue {
	const { headers: _headers, ...info } = model;
	return JSON.parse(JSON.stringify(info));
}
export async function catalogCall(
	name: string,
	args: unknown,
	models: Models,
	context: Context,
): Promise<JsonValue | undefined> {
	const list: unknown[] = Array.isArray(args) ? args : [];
	const [type, provider, id] = list;
	if (name === "models.getModelsOfType")
		return models.getModelsOfType(modelType(type), providerOf(provider)).map(publicModel);
	if (name === "models.getAvailableOfType")
		return (
			await models.getAvailableOfType(modelType(type), providerOf(provider), {
				...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }),
			})
		).map(publicModel);
	if (typeof provider !== "string" || typeof id !== "string")
		throw new Error(
			`models.getModelOfType(type, provider, id) expects three strings, got (${list.map(describe).join(", ")}). The provider and the id are separate arguments, for example models.getModelOfType("classifier", "typesafe", "jev-latest").`,
		);
	const found = models.getModelOfType(modelType(type), provider, id);
	return found === undefined ? undefined : publicModel(found);
}

const classifierShape =
	'{ state: { ... }, images?: [{ type: "image", data: <base64>, mimeType }], questions: { <id>: { type: "choice", instructions, criteria: { <label>: <meaning> } } | { type: "score", instructions, criteria: [<lowest level>, ..., <highest level>] } | { type: "bool", instructions, criteria: { true: <meaning>, false: <meaning> } } } }';
const imageBlock = (value: unknown): boolean =>
	record(value) && value.type === "image" && typeof value.data === "string" && typeof value.mimeType === "string";
function classifierContext(value: unknown): ClassifierContext {
	function fail(problem: string): never {
		throw new Error(`models.classify() ${problem}. Expected context: ${classifierShape}.`);
	}
	if (!record(value)) fail(`expects a context object as its second argument, got ${describe(value)}`);
	if (!record(value.state)) fail(`context.state must be an object, got ${describe(value.state)}`);
	if (value.images !== undefined) {
		if (!Array.isArray(value.images)) fail(`context.images must be an array, got ${describe(value.images)}`);
		for (const [index, image] of value.images.entries())
			if (!imageBlock(image)) fail(`context.images[${index}] must be an image block, got ${describe(image)}`);
	}
	if (!record(value.questions) || !Object.keys(value.questions).length)
		fail(`context.questions must map question IDs to questions, got ${describe(value.questions)}`);
	const strings = (items: unknown[]): boolean => items.length > 0 && items.every((item) => typeof item === "string");
	for (const [id, question] of Object.entries(value.questions)) {
		const path = `context.questions.${id}`;
		if (!record(question)) fail(`${path} must be a question object, got ${describe(question)}`);
		if (typeof question.instructions !== "string") fail(`${path}.instructions must be a string`);
		const criteria = question.criteria;
		switch (question.type) {
			case "choice":
				if (!record(criteria) || !strings(Object.values(criteria)))
					fail(`${path} is a "choice" question, so criteria must map each label to its meaning`);
				break;
			case "score":
				if (!Array.isArray(criteria) || !strings(criteria))
					fail(`${path} is a "score" question, so criteria must list the levels as strings, lowest first`);
				break;
			case "bool":
				if (!record(criteria) || typeof criteria.true !== "string" || typeof criteria.false !== "string")
					fail(`${path} is a "bool" question, so criteria must be { true: string, false: string }`);
				break;
			default:
				fail(`${path}.type must be "choice", "score", or "bool", got ${JSON.stringify(question.type)}`);
		}
	}
	return value as unknown as ClassifierContext;
}
function imagesContext(value: unknown): ImagesContext {
	function fail(problem: string): never {
		throw new Error(
			`models.generateImages() ${problem}. Expected context: { input: [{ type: "text", text: <prompt> }, ...optional { type: "image", data: <base64>, mimeType } references] }.`,
		);
	}
	if (!record(value)) fail(`expects a context object as its second argument, got ${describe(value)}`);
	if (!Array.isArray(value.input) || !value.input.length)
		fail(`context.input must be a non-empty array of blocks, got ${describe(value.input)}`);
	for (const [index, block] of value.input.entries())
		if (!(record(block) && block.type === "text" && typeof block.text === "string") && !imageBlock(block))
			fail(`context.input[${index}] must be a text or image block, got ${describe(block)}`);
	return value as unknown as ImagesContext;
}
function resolveModel<T extends "classifier" | "image">(
	name: string,
	type: T,
	candidate: unknown,
	models: Models,
): ModelTypeMap[T] {
	const hint = `List the ${type} models you can use with models.getAvailableOfType("${type}").`;
	if (!record(candidate) || typeof candidate.provider !== "string" || typeof candidate.id !== "string")
		throw new Error(
			`${name}() expects ${article(type)} model as its first argument, got ${describe(candidate)}.${candidate === null || candidate === undefined ? " models.getModelOfType() returns undefined for an unknown provider or id." : ""} ${hint}`,
		);
	const { provider, id } = candidate;
	const found = models.getModelOfType(type, provider, id);
	if (found) return found;
	const other = modelTypes.find((other) => other !== type && models.getModelOfType(other, provider, id) !== undefined);
	throw new Error(
		other
			? `"${provider}/${id}" is ${article(other)} model, not ${article(type)} model. ${hint}`
			: `Unknown ${type} model "${provider}/${id}". ${hint}`,
	);
}
function modelResult(label: string, result: { stopReason: string; errorMessage?: string; usage?: Usage }) {
	return {
		output: [
			{
				type: "text" as const,
				text:
					result.stopReason === "stop"
						? `${label} done`
						: `${label} ${result.stopReason}: ${result.errorMessage ?? ""}`,
			},
		],
		structuredOutput: JSON.parse(JSON.stringify(result)) as JsonValue,
		...(result.stopReason === "stop" ? {} : { isError: true }),
		...(result.usage === undefined ? {} : { usage: result.usage }),
	};
}
const parameters = Type.Object({ model: Type.Unknown(), context: Type.Unknown() });
export function createModelTools(): ToolRegistration[] {
	return [
		defineTool({
			name: CLASSIFY_TOOL,
			description: "models.classify() of code mode scripts.",
			parameters,
			structuredOutputSchema: Type.Unknown(),
			callers: ["tools"],
			async execute(args, api, context) {
				const model = resolveModel("models.classify", "classifier", args.model, api.models);
				const checked = classifierContext(args.context);
				const result = await api.models.classify(model, checked, {
					telemetry: context.telemetry,
					...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }),
				});
				return modelResult(`classify ${model.provider}/${model.id}`, result);
			},
		}),
		defineTool({
			name: GENERATE_IMAGES_TOOL,
			description: "models.generateImages() of code mode scripts.",
			parameters,
			structuredOutputSchema: Type.Unknown(),
			callers: ["tools"],
			async execute(args, api, context) {
				const model = resolveModel("models.generateImages", "image", args.model, api.models);
				const checked = imagesContext(args.context);
				const result = await api.models.generateImages(model, checked, {
					telemetry: context.telemetry,
					...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }),
				});
				return modelResult(`generateImages ${model.provider}/${model.id}`, result);
			},
		}),
	];
}
