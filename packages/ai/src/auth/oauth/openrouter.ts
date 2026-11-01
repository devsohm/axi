import { getProviderEnvValue } from "../../utils/provider-env.ts";
import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../types.ts";
import { startOAuthCallbackServer, waitForCallbackOrManualInput } from "./callback-server.ts";
import { generatePKCE } from "./pkce.ts";
function codeFrom(input: string): string | undefined {
	const text = input.trim();
	if (!text) return undefined;
	try {
		return new URL(text).searchParams.get("code") ?? undefined;
	} catch {}
	return text.includes("code=") ? (new URLSearchParams(text).get("code") ?? undefined) : text;
}
function detail(body: Record<string, unknown>): string | undefined {
	for (const key of ["error_description", "message", "error"]) if (typeof body[key] === "string") return body[key];
	if (
		body.error &&
		typeof body.error === "object" &&
		!Array.isArray(body.error) &&
		"message" in body.error &&
		typeof body.error.message === "string"
	)
		return body.error.message;
	return undefined;
}
async function exchange(code: string, verifier: string, signal: AbortSignal): Promise<OAuthCredential> {
	if (signal.aborted) throw new Error("Login cancelled");
	const controller = new AbortController(),
		abort = () => controller.abort(signal.reason);
	signal.addEventListener("abort", abort, { once: true });
	const timer = setTimeout(() => controller.abort(new Error("OpenRouter OAuth token exchange timed out")), 30000);
	let response: Response,
		body: Record<string, unknown> = {};
	try {
		response = await fetch("https://openrouter.ai/api/v1/auth/keys", {
			method: "POST",
			headers: { accept: "application/json", "content-type": "application/json" },
			body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
			signal: controller.signal,
		});
		try {
			const json: unknown = await response.json();
			if (json && typeof json === "object" && !Array.isArray(json)) body = json as Record<string, unknown>;
		} catch {
			if (response.ok) throw new Error("OpenRouter OAuth returned invalid JSON");
		}
	} catch (error) {
		if (signal.aborted) throw new Error("Login cancelled");
		if (controller.signal.aborted) throw new Error("OpenRouter OAuth token exchange timed out");
		throw error;
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", abort);
	}
	if (!response.ok) {
		const message = detail(body);
		throw new Error(`OpenRouter OAuth key exchange failed (HTTP ${response.status})${message ? `: ${message}` : ""}`);
	}
	if (typeof body.key !== "string" || !body.key.length) throw new Error('OpenRouter OAuth response carries no "key"');
	return { type: "oauth", access: body.key, refresh: "", expires: Number.MAX_SAFE_INTEGER };
}
async function login(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	const { verifier, challenge } = await generatePKCE();
	const callback = await startOAuthCallbackServer({
		providerName: "OpenRouter",
		host: getProviderEnvValue("AXI_OAUTH_CALLBACK_HOST") || "127.0.0.1",
		port: 0,
		path: `/oauth/callback/${crypto.randomUUID()}`,
		complete: (code) => exchange(code, verifier, interaction.signal),
		signal: interaction.signal,
		timeoutMs: 300000,
	});
	try {
		const query = new URLSearchParams({
			callback_url: callback.redirectUri,
			code_challenge: challenge,
			code_challenge_method: "S256",
		});
		interaction.notify({
			type: "progress",
			message: `Listening for OpenRouter OAuth callback on ${callback.redirectUri}`,
		});
		interaction.notify({
			type: "auth_url",
			url: `https://openrouter.ai/auth?${query}`,
			instructions:
				"Complete sign-in in your browser. If the browser is on another machine, paste the final redirect URL here.",
		});
		const result = await waitForCallbackOrManualInput(interaction, callback, {
			message: "Complete sign-in in your browser, or paste the authorization code / redirect URL here:",
			placeholder: callback.redirectUri,
		});
		if (result.type === "callback") return result.value;
		const code = codeFrom(result.input);
		if (!code) throw new Error("Missing authorization code");
		interaction.notify({ type: "progress", message: "Exchanging authorization code for an API key..." });
		return await exchange(code, verifier, interaction.signal);
	} finally {
		callback.close();
	}
}
export const openRouterOAuth: OAuthAuth = {
	name: "OpenRouter OAuth",
	loginLabel: "Sign in with OpenRouter",
	login,
	async refresh(credential) {
		return credential;
	},
	async toAuth(credential) {
		return { apiKey: credential.access };
	},
};
