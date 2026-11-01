import type {
	AnyModel,
	Api,
	AssistantImages,
	ClassifierApi,
	ClassifierContext,
	ClassifierModel,
	ClassifierResult,
	ImageApi,
	ImageModel,
	Model,
	ModelType,
	ModelTypeMap,
} from "../types.ts";
import { ModelsError } from "./models-error.ts";
export function getModelType(model: AnyModel): ModelType {
	return model.type ?? "chat";
}
export function isModelType<T extends ModelType>(model: AnyModel, type: T): model is ModelTypeMap[T] {
	return getModelType(model) === type;
}
export function assertChatModel(model: AnyModel): asserts model is Model<Api> {
	if (!isModelType(model, "chat"))
		throw new ModelsError("provider", `Model ${model.provider}/${model.id} is not a chat model`);
}
export function assertImageModel(model: AnyModel): asserts model is ImageModel<ImageApi> {
	if (!isModelType(model, "image"))
		throw new ModelsError("provider", `Model ${model.provider}/${model.id} is not an image model`);
}
export function assertClassifierModel(model: AnyModel): asserts model is ClassifierModel<ClassifierApi> {
	if (!isModelType(model, "classifier"))
		throw new ModelsError("provider", `Model ${model.provider}/${model.id} is not a classifier model`);
}
export function assertClassifierInputSupported(
	model: ClassifierModel<ClassifierApi>,
	context: ClassifierContext,
): void {
	if (context.images?.length && !model.input.includes("image"))
		throw new ModelsError("provider", `Model ${model.provider}/${model.id} does not accept image input`);
}
export function imageErrorResult(model: ImageModel<ImageApi>, error: unknown, aborted = false): AssistantImages {
	return {
		api: model.api,
		provider: model.provider,
		model: model.id,
		output: [],
		stopReason: aborted ? "aborted" : "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}
export function classifierErrorResult(
	model: ClassifierModel<ClassifierApi>,
	error: unknown,
	aborted = false,
): ClassifierResult {
	return {
		api: model.api,
		provider: model.provider,
		model: model.id,
		answers: {},
		stopReason: aborted ? "aborted" : "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}
