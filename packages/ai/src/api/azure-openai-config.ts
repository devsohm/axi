import type { Api, Model } from "../types.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";
import type { AzureEndpointOptions } from "./options.ts";

export type { AzureEndpointOptions } from "./options.ts";

export function resolveDeploymentName(model: Pick<Model<Api>, "id">, options?: AzureEndpointOptions): string {
	if (options?.azureDeploymentName) return options.azureDeploymentName;
	const mappings = new Map<string, string>();
	for (const entry of (getProviderEnvValue("AZURE_OPENAI_DEPLOYMENT_NAME_MAP", options?.env) ?? "").split(",")) {
		const [name, deployment] = entry.trim().split("=", 2);
		if (name && deployment) mappings.set(name.trim(), deployment.trim());
	}
	return mappings.get(model.id) || model.id;
}
export function resolveAzureBaseUrl(model: Pick<Model<Api>, "baseUrl">, options?: AzureEndpointOptions): string {
	const explicit = options?.azureBaseUrl?.trim() || getProviderEnvValue("AZURE_OPENAI_BASE_URL", options?.env)?.trim();
	const resource = options?.azureResourceName || getProviderEnvValue("AZURE_OPENAI_RESOURCE_NAME", options?.env);
	const base = explicit || (resource ? `https://${resource}.openai.azure.com/openai/v1` : model.baseUrl);
	if (!base)
		throw new Error(
			"Azure OpenAI base URL is required. Set AZURE_OPENAI_BASE_URL or AZURE_OPENAI_RESOURCE_NAME, or pass azureBaseUrl, azureResourceName, or model.baseUrl.",
		);
	let url: URL;
	try {
		url = new URL(base.trim().replace(/\/+$/, ""));
	} catch {
		throw new Error(`Invalid Azure OpenAI base URL: ${base}`);
	}
	const azure = [".openai.azure.com", ".cognitiveservices.azure.com", ".ai.azure.com"].some((suffix) =>
		url.hostname.endsWith(suffix),
	);
	if (azure && ["", "/", "/openai", "/openai/v1/responses"].includes(url.pathname.replace(/\/+$/, ""))) {
		url.pathname = "/openai/v1";
		url.search = "";
	}
	return url.toString().replace(/\/+$/, "");
}
export function resolveAzureConfig(
	model: Pick<Model<Api>, "baseUrl">,
	options?: AzureEndpointOptions,
): { baseUrl: string; apiVersion: string } {
	return {
		baseUrl: resolveAzureBaseUrl(model, options),
		apiVersion: options?.azureApiVersion || getProviderEnvValue("AZURE_OPENAI_API_VERSION", options?.env) || "v1",
	};
}
