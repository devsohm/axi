import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { getProviderEnvValue } from "../../utils/provider-env.ts";
import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction, LoginOptions } from "../types.ts";
import { startOAuthCallbackServer, waitForCallbackOrManualInput } from "./callback-server.ts";
import { pollOAuthDeviceCodeFlow } from "./device-code.ts";
import { generatePKCE } from "./pkce.ts";

const clientId = "app_EMoamEEZ73f0CkXaXp7hrann";
const origin = "https://auth.openai.com";
const redirect = "http://localhost:1455/auth/callback";
const tokenSchema = Type.Object({
	access_token: Type.String({ minLength: 1 }),
	refresh_token: Type.String({ minLength: 1 }),
	expires_in: Type.Number(),
});
const deviceSchema = Type.Object({
	device_auth_id: Type.String({ minLength: 1 }),
	user_code: Type.String({ minLength: 1 }),
	interval: Type.Union([Type.Number(), Type.String()]),
});
const codeSchema = Type.Object({
	authorization_code: Type.String({ minLength: 1 }),
	code_verifier: Type.String({ minLength: 1 }),
});
type Token = { access: string; refresh: string; expires: number };
type Device = { deviceAuthId: string; userCode: string; intervalSeconds: number };
async function loginFetch(url: string, init: RequestInit): Promise<Response> {
	try {
		return await fetch(url, init);
	} catch (error) {
		if (init.signal?.aborted) throw new Error("Login cancelled");
		throw error;
	}
}
async function tokenResponse(response: Response, operation: "exchange" | "refresh"): Promise<Token> {
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(`OpenAI Codex token ${operation} failed (${response.status}): ${body || response.statusText}`);
	}
	const json: unknown = await response.json();
	if (!Value.Check(tokenSchema, json))
		throw new Error(`OpenAI Codex token ${operation} response missing fields: ${JSON.stringify(json)}`);
	return { access: json.access_token, refresh: json.refresh_token, expires: Date.now() + json.expires_in * 1000 };
}
function credential(token: Token): OAuthCredential {
	let accountId: string | undefined;
	try {
		const parts = token.access.split(".");
		if (parts.length === 3) {
			const payload: unknown = JSON.parse(atob(parts[1] ?? ""));
			const schema = Type.Object({
				"https://api.openai.com/auth": Type.Object({ chatgpt_account_id: Type.String({ minLength: 1 }) }),
			});
			if (Value.Check(schema, payload)) accountId = payload["https://api.openai.com/auth"].chatgpt_account_id;
		}
	} catch {}
	if (!accountId) throw new Error("Failed to extract accountId from token");
	return { type: "oauth", ...token, accountId };
}
async function exchange(
	code: string,
	verifier: string,
	redirectUri: string,
	signal: AbortSignal,
): Promise<OAuthCredential> {
	const response = await loginFetch(`${origin}/oauth/token`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			client_id: clientId,
			code,
			code_verifier: verifier,
			redirect_uri: redirectUri,
		}),
		signal,
	});
	return credential(await tokenResponse(response, "exchange"));
}
async function deviceStart(signal: AbortSignal): Promise<Device> {
	const response = await loginFetch(`${origin}/api/accounts/deviceauth/usercode`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ client_id: clientId }),
		signal,
	});
	if (!response.ok) {
		if (response.status === 404)
			throw new Error(
				"OpenAI Codex device code login is not enabled for this server. Use browser login or verify the server URL.",
			);
		const body = await response.text().catch(() => "");
		throw new Error(`OpenAI Codex device code request failed with status ${response.status}${body ? `: ${body}` : ""}`);
	}
	const json: unknown = await response.json();
	if (!Value.Check(deviceSchema, json))
		throw new Error(`Invalid OpenAI Codex device code response: ${JSON.stringify(json)}`);
	const interval = typeof json.interval === "string" ? Number(json.interval.trim()) : json.interval;
	if (!Number.isFinite(interval) || interval < 0)
		throw new Error(`Invalid OpenAI Codex device code response: ${JSON.stringify(json)}`);
	return { deviceAuthId: json.device_auth_id, userCode: json.user_code, intervalSeconds: interval };
}
async function deviceLogin(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	const device = await deviceStart(interaction.signal);
	interaction.notify({
		type: "device_code",
		userCode: device.userCode,
		verificationUri: `${origin}/codex/device`,
		intervalSeconds: device.intervalSeconds,
		expiresInSeconds: 900,
	});
	const code = await pollOAuthDeviceCodeFlow<Static<typeof codeSchema>>({
		intervalSeconds: device.intervalSeconds,
		expiresInSeconds: 900,
		signal: interaction.signal,
		async poll() {
			const response = await loginFetch(`${origin}/api/accounts/deviceauth/token`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ device_auth_id: device.deviceAuthId, user_code: device.userCode }),
				signal: interaction.signal,
			});
			if (response.ok) {
				const json: unknown = await response.json();
				return Value.Check(codeSchema, json)
					? { status: "complete", value: json }
					: { status: "failed", message: `Invalid OpenAI Codex device auth token response: ${JSON.stringify(json)}` };
			}
			if (response.status === 403 || response.status === 404) return { status: "pending" };
			const body = await response.text().catch(() => "");
			let error: unknown;
			try {
				const parsed: unknown = JSON.parse(body);
				if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
					const value = parsed.error;
					error = typeof value === "object" && value !== null && "code" in value ? value.code : value;
				}
			} catch {}
			if (error === "deviceauth_authorization_pending") return { status: "pending" };
			if (error === "slow_down") return { status: "slow_down" };
			return {
				status: "failed",
				message: `OpenAI Codex device auth failed with status ${response.status}${body ? `: ${body}` : ""}`,
			};
		},
	});
	return exchange(code.authorization_code, code.code_verifier, `${origin}/deviceauth/callback`, interaction.signal);
}
function manualCode(input: string): { code?: string; state?: string } {
	const trimmed = input.trim();
	if (!trimmed) return {};
	try {
		const url = new URL(trimmed);
		return { code: url.searchParams.get("code") ?? undefined, state: url.searchParams.get("state") ?? undefined };
	} catch {}
	if (trimmed.includes("#")) {
		const [code, state] = trimmed.split("#", 2);
		return { code, state };
	}
	if (trimmed.includes("code=")) {
		const params = new URLSearchParams(trimmed);
		return { code: params.get("code") ?? undefined, state: params.get("state") ?? undefined };
	}
	return { code: trimmed };
}
async function browserLogin(interaction: ProviderAuthInteraction, options?: LoginOptions): Promise<OAuthCredential> {
	const { verifier, challenge } = await generatePKCE();
	const state = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	const url = new URL(`${origin}/oauth/authorize`);
	url.search = new URLSearchParams({
		response_type: "code",
		client_id: clientId,
		redirect_uri: redirect,
		scope: "openid profile email offline_access",
		code_challenge: challenge,
		code_challenge_method: "S256",
		state,
		id_token_add_organizations: "true",
		codex_cli_simplified_flow: "true",
		originator: options?.agentName ?? "axi",
	}).toString();
	const server = await startOAuthCallbackServer({
		providerName: "OpenAI",
		host: getProviderEnvValue("AXI_OAUTH_CALLBACK_HOST") || "127.0.0.1",
		port: 1455,
		path: "/auth/callback",
		state,
		complete: async (code) => code,
		signal: interaction.signal,
	}).catch(() => undefined);
	interaction.notify({
		type: "auth_url",
		url: url.toString(),
		instructions: "A browser window should open. Complete login to finish.",
	});
	try {
		const result = await waitForCallbackOrManualInput(interaction, server, {
			message: "Complete login in your browser, or paste the authorization code / redirect URL here:",
			placeholder: redirect,
		});
		let code: string | undefined;
		if (result.type === "callback") code = result.value;
		else {
			const parsed = manualCode(result.input);
			if (parsed.state && parsed.state !== state) throw new Error("State mismatch");
			code = parsed.code;
		}
		if (!code) throw new Error("Missing authorization code");
		return await exchange(code, verifier, redirect, interaction.signal);
	} finally {
		server?.close();
	}
}
export const openaiCodexOAuth: OAuthAuth = {
	name: "OpenAI (ChatGPT Plus/Pro)",
	isSubscription: true,
	async login(interaction, options) {
		const method = await interaction.prompt({
			type: "select",
			message: "Select OpenAI Codex login method:",
			options: [
				{ id: "browser", label: "Browser login (default)" },
				{ id: "device_code", label: "Device code login (headless)" },
			],
		});
		if (method === "device_code") return deviceLogin(interaction);
		if (method === "browser") return browserLogin(interaction, options);
		throw new Error(`Unknown OpenAI Codex login method: ${method}`);
	},
	async refresh(current, signal) {
		let response: Response;
		try {
			response = await fetch(`${origin}/oauth/token`, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: current.refresh, client_id: clientId }),
				signal,
			});
		} catch (error) {
			throw new Error(`OpenAI Codex token refresh error: ${error instanceof Error ? error.message : String(error)}`);
		}
		return credential(await tokenResponse(response, "refresh"));
	},
	async toAuth(current) {
		return { apiKey: current.access };
	},
};
