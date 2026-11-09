import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../types.ts";
import { pollOAuthDeviceCodeFlow } from "./device-code.ts";
import { positiveOAuthNumber } from "./device-http.ts";
const clientId = "b1a00492-073a-47ea-816f-4c329264a828",
	tokenUrl = "https://auth.x.ai/oauth2/token";
interface Reply {
	ok: boolean;
	status: number;
	body: Record<string, unknown>;
}
async function form(url: string, fields: Record<string, string>, signal: AbortSignal): Promise<Reply> {
	let response: Response;
	try {
		response = await fetch(url, {
			method: "POST",
			headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams(fields),
			signal,
		});
	} catch (error) {
		if (signal.aborted) throw new Error("Login cancelled");
		throw error;
	}
	let body: Record<string, unknown>;
	try {
		const json: unknown = await response.json();
		body = json && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : {};
	} catch {
		if (signal.aborted) throw new Error("Login cancelled");
		throw new Error(`xAI OAuth returned invalid JSON (HTTP ${response.status})`);
	}
	return { ok: response.ok, status: response.status, body };
}
function failure(action: string, reply: Reply): Error {
	const text = [reply.body.error, reply.body.error_description]
		.filter((value) => typeof value === "string" && value)
		.join(": ");
	return new Error(`xAI OAuth ${action} failed (HTTP ${reply.status})${text ? `: ${text}` : ""}`);
}
function string(body: Record<string, unknown>, name: string): string {
	const value = body[name];
	if (typeof value !== "string" || !value.length) throw new Error(`Invalid xAI OAuth response field: ${name}`);
	return value;
}
function number(body: Record<string, unknown>, name: string): number {
	const value = positiveOAuthNumber(body[name]);
	if (value === undefined) throw new Error(`Invalid xAI OAuth response field: ${name}`);
	return value;
}
function verification(text: string): string {
	try {
		const url = new URL(text);
		if (url.protocol === "https:") return url.href;
	} catch {}
	throw new Error("Untrusted verification URI in xAI OAuth response");
}
function credential(body: Record<string, unknown>, prior?: string): OAuthCredential {
	return {
		type: "oauth",
		access: string(body, "access_token"),
		refresh: body.refresh_token === undefined && prior ? prior : string(body, "refresh_token"),
		expires: Date.now() + (body.expires_in === undefined ? 3600 : number(body, "expires_in")) * 1000 - 300000,
	};
}
async function login(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	const signal = interaction.signal;
	const reply = await form(
		"https://auth.x.ai/oauth2/device/code",
		{ client_id: clientId, scope: "openid profile email offline_access grok-cli:access api:access", referrer: "axi" },
		signal,
	);
	if (!reply.ok) throw failure("device authorization", reply);
	const body = reply.body;
	const complete =
		typeof body.verification_uri_complete === "string" && body.verification_uri_complete.length
			? verification(body.verification_uri_complete)
			: undefined;
	const code = string(body, "device_code"),
		user = string(body, "user_code"),
		uri = verification(string(body, "verification_uri"));
	const intervalSeconds = positiveOAuthNumber(body.interval),
		expiresInSeconds = number(body, "expires_in");
	interaction.notify({
		type: "device_code",
		userCode: user,
		verificationUri: complete ?? uri,
		intervalSeconds,
		expiresInSeconds,
	});
	return pollOAuthDeviceCodeFlow<OAuthCredential>({
		intervalSeconds,
		expiresInSeconds,
		waitBeforeFirstPoll: true,
		signal,
		poll: async () => {
			const reply = await form(
				tokenUrl,
				{ grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: clientId, device_code: code },
				signal,
			);
			if (reply.ok) return { status: "complete", value: credential(reply.body) };
			switch (reply.body.error) {
				case "authorization_pending":
					return { status: "pending" };
				case "slow_down":
					return {
						status: "slow_down",
						intervalSeconds: typeof reply.body.interval === "number" ? reply.body.interval : undefined,
					};
				case "access_denied":
				case "authorization_denied":
					return { status: "failed", message: "xAI device authorization was denied" };
				case "expired_token":
					return { status: "failed", message: "xAI device code expired" };
				default:
					return { status: "failed", message: failure("device token polling", reply).message };
			}
		},
	});
}
export const xaiOAuth: OAuthAuth = {
	name: "xAI (Grok/X subscription)",
	isSubscription: true,
	loginLabel: "Sign in with SuperGrok or X Premium",
	login,
	async refresh(previous, signal) {
		const reply = await form(
			tokenUrl,
			{ grant_type: "refresh_token", client_id: clientId, refresh_token: previous.refresh },
			signal,
		);
		if (!reply.ok) throw failure("token refresh", reply);
		return credential(reply.body, previous.refresh);
	},
	async toAuth(credential) {
		return { apiKey: credential.access };
	},
};
