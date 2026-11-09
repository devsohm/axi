import type { FetchFunction } from "../types.ts";
export interface AiBinding {
	aiGatewayLogId: string | null;
	fetch?(input: Request | string | URL, init?: RequestInit): Promise<Response>;
}
export const CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL = "cloudflare-gateway-binding";
export function createAiBindingFetch(binding: AiBinding): FetchFunction {
	if (typeof binding.fetch !== "function")
		throw new TypeError("createAiBindingFetch: the AI binding does not expose fetch()");
	const send = binding.fetch.bind(binding);
	return (input, init) => send(input, init);
}
