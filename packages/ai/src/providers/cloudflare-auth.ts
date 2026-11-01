import type { ApiKeyAuth } from "../auth/types.ts";
import type { ProviderEnv } from "../types.ts";

function authentication(gateway: boolean): ApiKeyAuth {
	return {
		name: "Cloudflare API key",
		async login(interaction) {
			const key = await interaction.prompt({ type: "secret", message: "Enter Cloudflare API key" });
			const account = await interaction.prompt({ type: "text", message: "Enter Cloudflare account ID" });
			const env: ProviderEnv = { CLOUDFLARE_ACCOUNT_ID: account };
			if (gateway)
				env.CLOUDFLARE_GATEWAY_ID = await interaction.prompt({
					type: "text",
					message: "Enter Cloudflare AI Gateway ID",
				});
			return { type: "api_key", key, env };
		},
		async resolve({ ctx, credential, signal }) {
			const read = async (name: string) => {
				const stored = name === "CLOUDFLARE_API_KEY" ? credential?.key : credential?.env?.[name];
				if (stored !== undefined) return stored;
				signal.throwIfAborted();
				const value = await ctx.env(name);
				signal.throwIfAborted();
				return value;
			};
			const key = await read("CLOUDFLARE_API_KEY"),
				account = await read("CLOUDFLARE_ACCOUNT_ID"),
				id = gateway ? await read("CLOUDFLARE_GATEWAY_ID") : undefined;
			if (!key || !account || (gateway && !id)) return undefined;
			return {
				auth: gateway
					? { headers: { "cf-aig-authorization": `Bearer ${key}`, Authorization: null, "x-api-key": null } }
					: { apiKey: key },
				env: { CLOUDFLARE_ACCOUNT_ID: account, ...(id ? { CLOUDFLARE_GATEWAY_ID: id } : {}) },
				source: credential ? "stored credential" : "CLOUDFLARE_API_KEY",
			};
		},
	};
}
export const cloudflareWorkersAIAuth = (): ApiKeyAuth => authentication(false);
export const cloudflareAIGatewayAuth = (): ApiKeyAuth => authentication(true);
