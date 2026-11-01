import { MODELS, IMAGE_MODELS, CLASSIFIER_MODELS } from "../models.generated.ts";
import { createModels, type CreateModelsOptions, type MutableModels } from "../models.ts";
import type { Api, Model, ImageApi, ImageModel, ClassifierApi, ClassifierModel, AnyModel } from "../types.ts";
import { builtinProviders } from "./builtin.ts";
import manifest from "./data/.manifest.json" with { type: "json" };

export { builtinProviders };
export type BuiltinProvider = keyof typeof MODELS;
type ApiOf<M> = M extends { api: infer A extends string } ? A : never;
type ChatId<P extends BuiltinProvider> = keyof (typeof MODELS)[P];
type ImageId<P extends BuiltinProvider> = keyof (typeof IMAGE_MODELS)[P];
type ClassifierId<P extends BuiltinProvider> = keyof (typeof CLASSIFIER_MODELS)[P];
const chat: Readonly<Record<string, Readonly<Record<string, Model<Api>>>>> = MODELS;
const images: Readonly<Record<string, Readonly<Record<string, ImageModel<ImageApi>>>>> = IMAGE_MODELS;
const classifiers: Readonly<Record<string, Readonly<Record<string, ClassifierModel<ClassifierApi>>>>> =
	CLASSIFIER_MODELS;

export function getBuiltinModel<P extends BuiltinProvider, I extends ChatId<P>>(
	provider: P,
	id: I,
): Model<ApiOf<(typeof MODELS)[P][I]>> {
	return chat[provider]?.[String(id)] as Model<ApiOf<(typeof MODELS)[P][I]>>;
}
export function getBuiltinImageModel<P extends BuiltinProvider, I extends ImageId<P>>(
	provider: P,
	id: I,
): ImageModel<ApiOf<(typeof IMAGE_MODELS)[P][I]>> {
	return images[provider]?.[String(id)] as ImageModel<ApiOf<(typeof IMAGE_MODELS)[P][I]>>;
}
export function getBuiltinClassifierModel<P extends BuiltinProvider, I extends ClassifierId<P>>(
	provider: P,
	id: I,
): ClassifierModel<ApiOf<(typeof CLASSIFIER_MODELS)[P][I]>> {
	return classifiers[provider]?.[String(id)] as ClassifierModel<ApiOf<(typeof CLASSIFIER_MODELS)[P][I]>>;
}
export function getBuiltinProviders(): BuiltinProvider[] {
	return Object.keys(MODELS) as BuiltinProvider[];
}
export function getBuiltinModels<P extends BuiltinProvider>(
	provider: P,
): Model<ApiOf<(typeof MODELS)[P][ChatId<P>]>>[] {
	return Object.values(chat[provider] ?? {}) as Model<ApiOf<(typeof MODELS)[P][ChatId<P>]>>[];
}
export function getBuiltinImageModels<P extends BuiltinProvider>(
	provider: P,
): ImageModel<ApiOf<(typeof IMAGE_MODELS)[P][ImageId<P>]>>[] {
	return Object.values(images[provider] ?? {}) as ImageModel<ApiOf<(typeof IMAGE_MODELS)[P][ImageId<P>]>>[];
}
export function getBuiltinClassifierModels<P extends BuiltinProvider>(
	provider: P,
): ClassifierModel<ApiOf<(typeof CLASSIFIER_MODELS)[P][ClassifierId<P>]>>[] {
	return Object.values(classifiers[provider] ?? {}) as ClassifierModel<
		ApiOf<(typeof CLASSIFIER_MODELS)[P][ClassifierId<P>]>
	>[];
}
export function getAllBuiltinModels<P extends BuiltinProvider>(provider: P): AnyModel[] {
	return [...getBuiltinModels(provider), ...getBuiltinImageModels(provider), ...getBuiltinClassifierModels(provider)];
}
export function getBuiltinModelDataGeneratedAt(): number | undefined {
	const time = Date.parse(manifest.generatedAt);
	return Number.isNaN(time) ? undefined : time;
}
export function builtinModels(options?: CreateModelsOptions): MutableModels {
	const models = createModels(options);
	for (const provider of builtinProviders()) models.setProvider(provider);
	return models;
}
