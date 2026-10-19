import type { ProviderClassifier, ProviderEnv, ProviderStreams } from "../types.ts";

export function resolveCloudflareModel<M extends { baseUrl: string }>(model: M, env: ProviderEnv | undefined): M {
	if (!env) return model;
	let baseUrl = model.baseUrl;
	for (const name of ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_GATEWAY_ID"]) {
		const placeholder = `{${name}}`;
		baseUrl = baseUrl.replaceAll(placeholder, env[name] ?? placeholder);
	}
	return baseUrl === model.baseUrl ? model : { ...model, baseUrl };
}
export function cloudflareStreams(api: ProviderStreams): ProviderStreams {
	return {
		stream: (model, context, options) => api.stream(resolveCloudflareModel(model, options?.env), context, options),
		streamSimple: (model, context, options) =>
			api.streamSimple(resolveCloudflareModel(model, options?.env), context, options),
	};
}
export function cloudflareClassifier(api: ProviderClassifier): ProviderClassifier {
	return {
		classify: (model, context, options) => api.classify(resolveCloudflareModel(model, options?.env), context, options),
	};
}
