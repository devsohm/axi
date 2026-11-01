import type { Models, MutableModels } from "../models.ts";
import { AXI_AI_VERSION } from "./version.ts";

export type UserAgentMode = "short" | "detailed" | { custom: string };
export interface ClientAttribution {
	name: string;
	url: string;
	categories?: string[];
}
export interface ClientIdentity {
	userAgent?: UserAgentMode;
	attribution?: ClientAttribution | null;
	version?: string;
}
export interface ClientIdentityTarget {
	readonly provider: string;
	readonly baseUrl: string;
}
export const AXI_ATTRIBUTION: ClientAttribution = {
	name: "axi",
	url: "https://github.com/devsohm/axi",
	categories: ["cli-agent"],
};

export function mergeClientIdentity(...sources: (ClientIdentity | undefined)[]): ClientIdentity | undefined {
	let merged: ClientIdentity | undefined;
	for (const source of sources) {
		if (!source) continue;
		merged ??= {};
		if (source.userAgent !== undefined) merged.userAgent = source.userAgent;
		if (source.attribution !== undefined) merged.attribution = source.attribution;
		if (source.version !== undefined) merged.version = source.version;
	}
	return merged;
}
export function getClientVersion(identity?: ClientIdentity): string {
	return identity?.version ?? AXI_AI_VERSION;
}
export function formatUserAgent(identity?: ClientIdentity): string {
	const mode = identity?.userAgent ?? "detailed";
	if (typeof mode === "object") return mode.custom;
	if (mode === "short") return "axi";
	const product = `axi/${getClientVersion(identity)}`;
	return typeof process !== "undefined" && process.versions?.node
		? `${product} (${process.platform}; node/${process.version}; ${process.arch})`
		: `${product} (browser)`;
}
function hostIs(url: string, host: string): boolean {
	try {
		return new URL(url).hostname === host;
	} catch {
		return false;
	}
}
function openCode(target: ClientIdentityTarget): boolean {
	return target.provider === "opencode" || target.provider === "opencode-go" || hostIs(target.baseUrl, "opencode.ai");
}
export function getAttributionHeaders(target: ClientIdentityTarget, identity?: ClientIdentity): Record<string, string> {
	const value = identity?.attribution;
	if (!value) return {};
	if (target.provider === "openrouter" || target.baseUrl.includes("openrouter.ai"))
		return {
			"HTTP-Referer": value.url,
			"X-OpenRouter-Title": value.name,
			...(value.categories?.length ? { "X-OpenRouter-Categories": value.categories.join(",") } : {}),
		};
	if (target.provider === "nvidia" || hostIs(target.baseUrl, "integrate.api.nvidia.com"))
		return { "X-BILLING-INVOKE-ORIGIN": value.name.charAt(0).toUpperCase() + value.name.slice(1) };
	return openCode(target) ? { "x-opencode-client": value.name } : {};
}
export function getOpenCodeSessionHeaders(
	target: ClientIdentityTarget,
	sessionId: string | undefined,
): Record<string, string> | undefined {
	return sessionId && openCode(target) ? { "x-opencode-session": sessionId } : undefined;
}
export function getIdentityHeaders(target: ClientIdentityTarget, identity?: ClientIdentity): Record<string, string> {
	return { "User-Agent": formatUserAgent(identity), ...getAttributionHeaders(target, identity) };
}
export function withClientIdentity(models: MutableModels, identity: ClientIdentity): MutableModels;
export function withClientIdentity(models: Models, identity: ClientIdentity): Models;
export function withClientIdentity(models: Models, identity: ClientIdentity): Models {
	const patch = (options?: { identity?: ClientIdentity }) => ({
		identity: mergeClientIdentity(identity, options?.identity),
	});
	const wrapped: Models = {
		getProviders: () => models.getProviders(),
		getProvider: (id) => models.getProvider(id),
		getModels: (provider) => models.getModels(provider),
		getModel: (provider, id) => models.getModel(provider, id),
		getModelsOfType: (type, provider) => models.getModelsOfType(type, provider),
		getModelOfType: (type, provider, id) => models.getModelOfType(type, provider, id),
		getAllModels: (provider) => models.getAllModels(provider),
		refresh: (options) => models.refresh(options),
		checkAuth: (provider, options) => models.checkAuth(provider, options),
		getAuth: models.getAuth.bind(models),
		getAvailable: (provider, options) => models.getAvailable(provider, options),
		getAvailableOfType: (type, provider, options) => models.getAvailableOfType(type, provider, options),
		getAllAvailable: (provider, options) => models.getAllAvailable(provider, options),
		login: (provider, type, interaction, options) => models.login(provider, type, interaction, options),
		logout: (provider, options) => models.logout(provider, options),
		stream: (model, context, options) => models.stream(model, context, Object.assign({}, options, patch(options))),
		complete: (model, context, options) => models.complete(model, context, Object.assign({}, options, patch(options))),
		streamSimple: (model, context, options) =>
			models.streamSimple(model, context, Object.assign({}, options, patch(options))),
		completeSimple: (model, context, options) =>
			models.completeSimple(model, context, Object.assign({}, options, patch(options))),
		streamDeferred: (model, handle, options) =>
			models.streamDeferred(model, handle, Object.assign({}, options, patch(options))),
		fetchDeferred: (model, handle, options) =>
			models.fetchDeferred(model, handle, Object.assign({}, options, patch(options))),
		cancelDeferred: (model, handle, options) =>
			models.cancelDeferred(model, handle, Object.assign({}, options, patch(options))),
		generateImages: (model, context, options) =>
			models.generateImages(model, context, Object.assign({}, options, patch(options))),
		classify: (model, context, options) => models.classify(model, context, Object.assign({}, options, patch(options))),
	};
	if (!mutable(models)) return wrapped;
	const result: MutableModels = {
		...wrapped,
		setProvider: (provider) => models.setProvider(provider),
		deleteProvider: (id) => models.deleteProvider(id),
		clearProviders: () => models.clearProviders(),
	};
	return result;
}

function mutable(models: Models): models is MutableModels {
	return (
		"setProvider" in models &&
		typeof models.setProvider === "function" &&
		"deleteProvider" in models &&
		typeof models.deleteProvider === "function" &&
		"clearProviders" in models &&
		typeof models.clearProviders === "function"
	);
}
