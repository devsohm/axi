import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../types.ts";
import { pollOAuthDeviceCodeFlow } from "./device-code.ts";
import { deviceForm, oauthJson, oauthRequestSignal, positiveOAuthNumber, trustedOAuthUrl } from "./device-http.ts";
const clientId = "1031625952748946",
	mintUrl = "https://api.meta.ai/muse-code/key";
function detail(json: Record<string, unknown> | null): string {
	for (const key of ["error_description", "detail", "message", "error"]) {
		const value = json?.[key];
		if (typeof value === "string" && value.trim()) return `: ${value.trim()}`;
	}
	return "";
}
async function mint(identity: string, signal: AbortSignal): Promise<OAuthCredential> {
	const response = await fetch(mintUrl, {
		method: "POST",
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${identity}`,
			"Content-Type": "application/json",
			"x-api-version": "1.0.0",
		},
		body: "{}",
		signal: oauthRequestSignal(signal),
	});
	const json = await oauthJson(response);
	if (response.status === 401 || response.status === 403)
		throw new Error(
			`Meta session expired (status ${response.status}). Run \`/login meta\` to sign in again.${detail(json)}`,
		);
	if (!response.ok) throw new Error(`Meta API key mint failed with status ${response.status}${detail(json)}`);
	const key = json?.api_key;
	if (typeof key !== "string" || !key) {
		const url = trustedOAuthUrl(json?.action_url);
		throw new Error(`Meta did not issue an API key.${url ? ` Complete setup at ${url}` : ""}`);
	}
	return { type: "oauth", refresh: identity, access: key, expires: Date.now() + 86400000 };
}
async function login(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	const signal = interaction.signal;
	try {
		const response = await deviceForm(
				"https://auth.meta.com/oidc/device/authorization/",
				{ client_id: clientId },
				signal,
			),
			device = await oauthJson(response);
		if (!response.ok)
			throw new Error(`Meta device authorization failed with status ${response.status}${detail(device)}`);
		const code = device?.device_code,
			user = device?.user_code,
			uri = trustedOAuthUrl(device?.verification_uri_complete) ?? trustedOAuthUrl(device?.verification_uri);
		if (typeof code !== "string" || !code || typeof user !== "string" || !user || !uri)
			throw new Error(`Invalid Meta device authorization response: ${JSON.stringify(device)}`);
		const intervalSeconds = positiveOAuthNumber(device?.interval),
			expiresInSeconds = positiveOAuthNumber(device?.expires_in);
		interaction.notify({
			type: "device_code",
			userCode: user,
			verificationUri: uri,
			intervalSeconds,
			expiresInSeconds,
		});
		const identity = await pollOAuthDeviceCodeFlow<string>({
			intervalSeconds,
			expiresInSeconds,
			waitBeforeFirstPoll: true,
			signal,
			poll: async () => {
				const response = await deviceForm(
						"https://auth.meta.com/oidc/device/token/",
						{ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: code, client_id: clientId },
						signal,
					),
					json = await oauthJson(response);
				if (response.ok && typeof json?.access_token === "string" && json.access_token)
					return { status: "complete", value: json.access_token };
				switch (json?.error) {
					case "authorization_pending":
						return { status: "pending" };
					case "slow_down":
						return { status: "slow_down", intervalSeconds: positiveOAuthNumber(json.interval) };
					case "access_denied":
						return { status: "failed", message: "Meta login was denied." };
					case "expired_token":
						return { status: "failed", message: "Meta device authorization expired. Please restart login." };
					default:
						return {
							status: "failed",
							message: `Meta device token request failed with status ${response.status}${detail(json)}`,
						};
				}
			},
		});
		interaction.notify({ type: "progress", message: "Enabling Meta Model API access..." });
		return await mint(identity, signal);
	} catch (error) {
		if (signal.aborted) throw new Error("Login cancelled");
		throw error;
	}
}
export const metaOAuth: OAuthAuth = {
	name: "Meta (Muse subscription)",
	isSubscription: true,
	loginLabel: "Sign in with Meta",
	login,
	refresh: (credential, signal) => mint(credential.refresh, signal),
	async toAuth(credential) {
		return { apiKey: credential.access };
	},
};
