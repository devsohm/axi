import type { ImagesFunction } from "../../types.ts";
import { registerImagesApiProvider } from "../../images-api-registry.ts";
let adapter: Promise<typeof import("../../api/openrouter-images.ts")> | undefined;
export const generateImagesOpenRouter: ImagesFunction = async (model, context, options) => {
	try {
		return await (await (adapter ??= import("../../api/openrouter-images.ts"))).generateImages(model, context, options);
	} catch (error) {
		return {
			api: model.api,
			provider: model.provider,
			model: model.id,
			timestamp: Date.now(),
			output: [],
			stopReason: "error",
			errorMessage: error instanceof Error ? error.message : String(error),
		};
	}
};
export function registerBuiltInImagesApiProviders(): void {
	registerImagesApiProvider({ api: "openrouter-images", generateImages: generateImagesOpenRouter });
}
registerBuiltInImagesApiProviders();
