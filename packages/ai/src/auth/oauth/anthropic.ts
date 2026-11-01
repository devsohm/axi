import { getProviderEnvValue } from "../../utils/provider-env.ts";
import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../types.ts";
import { startOAuthCallbackServer, waitForCallbackOrManualInput } from "./callback-server.ts";
import { generatePKCE } from "./pkce.ts";
const clientId = "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
	tokenUrl = "https://platform.claude.com/v1/oauth/token";
const callbackHost = getProviderEnvValue("AXI_OAUTH_CALLBACK_HOST") || "127.0.0.1";
const preferredRedirect = "http://localhost:53692/callback",
	copyRedirect = "https://platform.claude.com/oauth/code/callback";
function authorization(input: string): { code?: string; state?: string } {
	const text = input.trim();
	if (!text) return {};
	try {
		const url = new URL(text);
		return { code: url.searchParams.get("code") ?? undefined, state: url.searchParams.get("state") ?? undefined };
	} catch {}
	if (text.includes("#")) {
		const [code, state] = text.split("#", 2);
		return { code, state };
	}
	if (text.includes("code=")) {
		const query = new URLSearchParams(text);
		return { code: query.get("code") ?? undefined, state: query.get("state") ?? undefined };
	}
	return { code: text };
}
function details(error: unknown): string {
	if (!(error instanceof Error)) return String(error);
	return [
		`${error.name}: ${error.message}`,
		...("code" in error && error.code ? [`code=${error.code}`] : []),
		...("errno" in error && error.errno !== undefined ? [`errno=${String(error.errno)}`] : []),
		...(error.cause !== undefined ? [`cause=${details(error.cause)}`] : []),
		...(error.stack ? [`stack=${error.stack}`] : []),
	].join("; ");
}
async function tokenRequest(
	body: Record<string, string>,
	signal: AbortSignal,
	redirectUri?: string,
): Promise<OAuthCredential> {
	let text: string;
	try {
		const response = await fetch(tokenUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json" },
			body: JSON.stringify({ ...body, client_id: clientId }),
			signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
		});
		text = await response.text();
		if (!response.ok) throw new Error(`HTTP request failed. status=${response.status}; url=${tokenUrl}; body=${text}`);
	} catch (error) {
		throw new Error(
			redirectUri
				? `Token exchange request failed. url=${tokenUrl}; redirect_uri=${redirectUri}; response_type=authorization_code; details=${details(error)}`
				: `Anthropic token refresh request failed. url=${tokenUrl}; details=${details(error)}`,
		);
	}
	let data: { access_token: string; refresh_token: string; expires_in: number };
	try {
		data = JSON.parse(text);
	} catch (error) {
		throw new Error(
			`${redirectUri ? "Token exchange" : "Anthropic token refresh"} returned invalid JSON. url=${tokenUrl}; body=${text}; details=${details(error)}`,
		);
	}
	return {
		type: "oauth",
		access: data.access_token,
		refresh: data.refresh_token,
		expires: Date.now() + data.expires_in * 1000 - 300000,
	};
}
async function login(interaction: ProviderAuthInteraction, copy: boolean): Promise<OAuthCredential> {
	const { verifier, challenge } = await generatePKCE();
	const openCallback = (port: number) =>
		startOAuthCallbackServer({
			providerName: "Anthropic",
			host: callbackHost,
			port,
			path: "/callback",
			redirectHost: "localhost",
			state: verifier,
			complete: async (code) => code,
			signal: interaction.signal,
		});
	const callback = copy
		? undefined
		: await openCallback(53692)
				.catch(() => openCallback(0))
				.catch(() => undefined);
	const redirect = copy ? copyRedirect : (callback?.redirectUri ?? preferredRedirect);
	try {
		const query = new URLSearchParams({
			code: "true",
			client_id: clientId,
			response_type: "code",
			redirect_uri: redirect,
			scope:
				"org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
			code_challenge: challenge,
			code_challenge_method: "S256",
			state: verifier,
		});
		interaction.notify({
			type: "auth_url",
			url: `https://claude.ai/oauth/authorize?${query}`,
			instructions: copy
				? "Complete login in your browser, then copy the code Anthropic shows and paste it here."
				: "Complete login in your browser. If the browser is on another machine, paste the final redirect URL here.",
		});
		let code: string | undefined,
			state = verifier;
		if (copy) {
			const value = authorization(
				await interaction.prompt({
					type: "manual_code",
					message: "Paste the code Anthropic shows after you sign in:",
					placeholder: "code#state",
					signal: interaction.signal,
				}),
			);
			if (value.state && value.state !== verifier) throw new Error("OAuth state mismatch");
			code = value.code;
			state = value.state ?? verifier;
		} else {
			const result = await waitForCallbackOrManualInput(interaction, callback, {
				message: "Complete login in your browser, or paste the authorization code / redirect URL here:",
				placeholder: redirect,
			});
			if (result.type === "callback") code = result.value;
			else {
				const value = authorization(result.input);
				if (value.state && value.state !== verifier) throw new Error("OAuth state mismatch");
				code = value.code;
				state = value.state ?? verifier;
			}
		}
		if (!code) throw new Error("Missing authorization code");
		interaction.notify({ type: "progress", message: "Exchanging authorization code for tokens..." });
		return await tokenRequest(
			{ grant_type: "authorization_code", code, state, redirect_uri: redirect, code_verifier: verifier },
			interaction.signal,
			redirect,
		);
	} finally {
		callback?.close();
	}
}
export const anthropicOAuth: OAuthAuth = {
	name: "Anthropic (Claude Pro/Max)",
	isSubscription: true,
	async login(interaction) {
		const selected = await interaction.prompt({
			type: "select",
			message: "Select Anthropic login method:",
			options: [
				{ id: "browser", label: "Browser login (default)" },
				{ id: "copy_code", label: "Copy code login (headless)" },
			],
		});
		if (selected !== "browser" && selected !== "copy_code")
			throw new Error(`Unknown Anthropic login method: ${selected}`);
		return login(interaction, selected === "copy_code");
	},
	refresh: (credential, signal) =>
		tokenRequest({ grant_type: "refresh_token", refresh_token: credential.refresh }, signal),
	async toAuth(credential) {
		return { apiKey: credential.access };
	},
};
