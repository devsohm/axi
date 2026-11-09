import type { ApiKeyAuth, OAuthAuth } from "./types.ts";
export function envApiKeyAuth(name: string, envVars: readonly string[]): ApiKeyAuth {
	return {
		name,
		async login(interaction) {
			interaction.signal.throwIfAborted();
			const key = await interaction.prompt({ type: "secret", message: `Enter ${name}` });
			interaction.signal.throwIfAborted();
			return { type: "api_key", key };
		},
		async resolve({ ctx, credential, signal }) {
			signal.throwIfAborted();
			if (credential?.key)
				return { auth: { apiKey: credential.key }, env: credential.env, source: "stored credential" };
			for (const variable of envVars) {
				const key = await ctx.env(variable);
				signal.throwIfAborted();
				if (key) return { auth: { apiKey: key }, source: variable };
			}
			return undefined;
		},
	};
}
export function lazyOAuth(input: {
	name: string;
	isSubscription?: boolean;
	loginLabel?: string;
	load: () => Promise<OAuthAuth>;
}): OAuthAuth {
	let loaded: Promise<OAuthAuth> | undefined;
	const get = () => (loaded ??= input.load());
	return {
		name: input.name,
		isSubscription: input.isSubscription,
		loginLabel: input.loginLabel,
		login: async (interaction, options) => (await get()).login(interaction, options),
		refresh: async (credential, signal) => (await get()).refresh(credential, signal),
		toAuth: async (credential) => (await get()).toAuth(credential),
	};
}
