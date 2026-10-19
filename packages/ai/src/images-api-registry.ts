import type { AssistantImages, ImageApi, ImageModel, ImagesContext, ImagesFunction, ImagesOptions } from "./types.ts";
export type ImagesApiFunction = (
	model: ImageModel<ImageApi>,
	context: ImagesContext,
	options?: ImagesOptions,
) => Promise<AssistantImages>;
export interface ImagesApiProvider<A extends ImageApi = ImageApi, O extends ImagesOptions = ImagesOptions> {
	api: A;
	generateImages: ImagesFunction<O>;
}
const registry = new Map<ImageApi, { provider: ImagesApiProvider; sourceId?: string }>();
export function registerImagesApiProvider<A extends ImageApi, O extends ImagesOptions>(
	provider: ImagesApiProvider<A, O>,
	sourceId?: string,
): void {
	const { api, generateImages } = provider;
	registry.set(api, {
		sourceId,
		provider: {
			api,
			generateImages: (model, context, options) => {
				if (model.api !== api) throw new Error(`Mismatched api: ${model.api} expected ${api}`);
				return generateImages(model, context, options as O);
			},
		},
	});
}
export function getImagesApiProvider(api: ImageApi): ImagesApiProvider | undefined {
	return registry.get(api)?.provider;
}
