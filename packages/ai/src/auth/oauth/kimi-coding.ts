import { getProviderEnvValue } from "../../utils/provider-env.ts";
import { sleep } from "../../utils/sleep.ts";
import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../types.ts";
import { pollOAuthDeviceCodeFlow } from "./device-code.ts";
import { deviceForm, oauthJson, positiveOAuthNumber, trustedOAuthUrl } from "./device-http.ts";
const clientId = "17e5f671-d194-4dfb-9706-5516cb48c098";
const host = () =>
	(
		getProviderEnvValue("KIMI_CODE_OAUTH_HOST") ||
		getProviderEnvValue("KIMI_OAUTH_HOST") ||
		"https://auth.kimi.com"
	).replace(/\/+$/, "");
function credential(json: Record<string, unknown> | null, operation: string): OAuthCredential {
	const access = json?.access_token,
		refresh = json?.refresh_token,
		lifetime = positiveOAuthNumber(json?.expires_in);
	if (typeof access !== "string" || !access || typeof refresh !== "string" || !refresh || lifetime === undefined)
		throw new Error(`Kimi Code token ${operation} response missing fields: ${JSON.stringify(json)}`);
	return { type: "oauth", access, refresh, expires: Date.now() + lifetime * 1000 };
}
async function login(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	const base = host(),
		signal = interaction.signal;
	const response = await deviceForm(`${base}/api/oauth/device_authorization`, { client_id: clientId }, signal);
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`Kimi Code device authorization failed with status ${response.status}${text ? `: ${text}` : ""}`);
	}
	const device = await oauthJson(response),
		code = device?.device_code,
		user = device?.user_code,
		verification = device?.verification_uri,
		complete = device?.verification_uri_complete;
	if (
		typeof code !== "string" ||
		typeof user !== "string" ||
		typeof verification !== "string" ||
		typeof complete !== "string" ||
		!trustedOAuthUrl(complete) ||
		!trustedOAuthUrl(verification)
	)
		throw new Error(`Invalid Kimi Code device authorization response: ${JSON.stringify(device)}`);
	const intervalSeconds = positiveOAuthNumber(device?.interval) ?? 5,
		expiresInSeconds = positiveOAuthNumber(device?.expires_in) ?? 900;
	interaction.notify({
		type: "device_code",
		userCode: user,
		verificationUri: complete,
		intervalSeconds,
		expiresInSeconds,
	});
	return pollOAuthDeviceCodeFlow<OAuthCredential>({
		intervalSeconds,
		expiresInSeconds,
		waitBeforeFirstPoll: true,
		signal,
		poll: async () => {
			const response = await deviceForm(
				`${base}/api/oauth/token`,
				{ client_id: clientId, device_code: code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" },
				signal,
			);
			if (response.status >= 500) {
				const text = await response.text().catch(() => "");
				return {
					status: "failed",
					message: `Kimi Code device token request failed with status ${response.status}${text ? `: ${text}` : ""}`,
				};
			}
			const json = await oauthJson(response);
			if (response.ok && typeof json?.access_token === "string") {
				try {
					return { status: "complete", value: credential(json, "poll") };
				} catch (error) {
					return { status: "failed", message: error instanceof Error ? error.message : String(error) };
				}
			}
			switch (json?.error) {
				case "authorization_pending":
					return { status: "pending" };
				case "slow_down":
					return {
						status: "slow_down",
						intervalSeconds: typeof json.interval === "number" && json.interval > 0 ? json.interval : undefined,
					};
				case "expired_token":
					return { status: "failed", message: "Kimi Code device authorization expired. Please restart login." };
				case "access_denied":
					return { status: "failed", message: "Kimi Code login was denied." };
				default:
					return {
						status: "failed",
						message: `Kimi Code device token request failed (status ${response.status})${typeof json?.error === "string" ? `: ${json.error}${typeof json.error_description === "string" ? `: ${json.error_description}` : ""}` : ""}`,
					};
			}
		},
	});
}
async function refresh(credentialValue: OAuthCredential, signal: AbortSignal): Promise<OAuthCredential> {
	const base = host();
	let last: Error | undefined;
	for (let attempt = 0; attempt <= 3; attempt++) {
		if (attempt) await sleep(1000 * 2 ** (attempt - 1), signal);
		if (signal.aborted) throw new Error("Kimi Code token refresh aborted");
		let response: Response;
		try {
			response = await deviceForm(
				`${base}/api/oauth/token`,
				{ client_id: clientId, grant_type: "refresh_token", refresh_token: credentialValue.refresh },
				signal,
			);
		} catch (error) {
			last = error instanceof Error ? error : new Error(String(error));
			continue;
		}
		const json = await oauthJson(response);
		if (response.ok) return credential(json, "refresh");
		if (response.status === 401 || response.status === 403 || json?.error === "invalid_grant")
			throw new Error(
				`Kimi Code token refresh unauthorized (status ${response.status})${typeof json?.error_description === "string" ? `: ${json.error_description}` : ""}`,
			);
		if ((response.status === 429 || response.status >= 500) && attempt < 3) {
			last = new Error(`Kimi Code token refresh failed with status ${response.status}`);
			continue;
		}
		const text = JSON.stringify(json);
		throw new Error(`Kimi Code token refresh failed with status ${response.status}${text ? `: ${text}` : ""}`);
	}
	throw last ?? new Error("Kimi Code token refresh failed");
}
export const kimiCodingOAuth: OAuthAuth = {
	name: "Kimi Code (subscription)",
	isSubscription: true,
	loginLabel: "Sign in with Kimi Code",
	login,
	refresh,
	async toAuth(credential) {
		return { headers: { Authorization: `Bearer ${credential.access}` } };
	},
};
