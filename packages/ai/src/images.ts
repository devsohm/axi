import "./providers/images/register-builtins.ts";
import { getImagesApiProvider } from "./images-api-registry.ts";
import type { AssistantImages, ImageApi, ImageModel, ImagesContext, ProviderImagesOptions } from "./types.ts";
export async function generateImages(
	model: ImageModel<ImageApi>,
	context: ImagesContext,
	options?: ProviderImagesOptions,
): Promise<AssistantImages> {
	const adapter = getImagesApiProvider(model.api);
	if (!adapter) throw new Error(`No API provider registered for api: ${model.api}`);
	return adapter.generateImages(model, context, options);
}
