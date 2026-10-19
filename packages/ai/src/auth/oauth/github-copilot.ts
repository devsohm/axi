import { GITHUB_COPILOT_MODELS } from "../../providers/github-copilot.models.ts";
import { sleep } from "../../utils/sleep.ts";
import type { OAuthAuth, OAuthCredential } from "../types.ts";
import { pollOAuthDeviceCodeFlow } from "./device-code.ts";
import { trustedOAuthUrl } from "./device-http.ts";

const clientId = "Iv1.b507a08c87ecfe98";
const headers = {
	"User-Agent": "GitHubCopilotChat/0.35.0",
	"Editor-Version": "vscode/1.107.0",
	"Editor-Plugin-Version": "copilot-chat/0.35.0",
	"Copilot-Integration-Id": "vscode-chat",
};
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
function domain(input: string): string | undefined {
	if (!input.trim()) return undefined;
	try {
		return new URL(input.includes("://") ? input.trim() : `https://${input.trim()}`).hostname;
	} catch {
		return undefined;
	}
}
function enterprise(credential: OAuthCredential): string | undefined {
	return typeof credential.enterpriseUrl === "string" ? domain(credential.enterpriseUrl) : undefined;
}
function endpoint(token: string, host?: string): string {
	const proxy = /proxy-ep=([^;]+)/.exec(token)?.[1];
	return proxy
		? `https://${proxy.replace(/^proxy\./, "api.")}`
		: host
			? `https://copilot-api.${host}`
			: "https://api.individual.githubcopilot.com";
}
async function checkedJson(response: Response): Promise<unknown> {
	if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
	return response.json();
}
async function limitedFetch(url: string, init: RequestInit, signal: AbortSignal, retries: number): Promise<Response> {
	const budget = retries > 0 ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : signal;
	const deadline = retries > 0 ? Date.now() + 5000 : Infinity;
	for (let attempt = 0; ; attempt++) {
		const response = await fetch(url, { ...init, signal: AbortSignal.any([budget, AbortSignal.timeout(5000)]) });
		if (response.status !== 429 || attempt === retries) return response;
		const retryAfter = response.headers.get("retry-after");
		let delay = 500 * 2 ** attempt;
		if (retryAfter) {
			const seconds = Number.parseFloat(retryAfter);
			delay = Number.isNaN(seconds) ? Date.parse(retryAfter) - Date.now() : seconds * 1000;
			if (!Number.isFinite(delay)) return response;
		}
		delay = Math.max(0, delay);
		if (delay >= deadline - Date.now()) return response;
		await response.body?.cancel();
		await sleep(delay, budget);
	}
}
async function accountCatalog(token: string, host: string | undefined, signal: AbortSignal, retries: number) {
	const base = endpoint(token, host);
	const raw = await checkedJson(
		await limitedFetch(
			`${base}/models`,
			{
				headers: {
					Accept: "application/json",
					Authorization: `Bearer ${token}`,
					...headers,
					"X-GitHub-Api-Version": "2026-06-01",
				},
			},
			signal,
			retries,
		),
	);
	if (!record(raw) || !Array.isArray(raw.data)) throw new Error("Invalid Copilot models response");
	const models: { id: string; picker: boolean; policy: unknown }[] = [];
	for (const item of raw.data) {
		if (!record(item) || typeof item.id !== "string") continue;
		const capabilities = record(item.capabilities) ? item.capabilities : undefined;
		const supports = record(capabilities?.supports) ? capabilities.supports : undefined;
		if (supports?.tool_calls === false) continue;
		models.push({
			id: item.id,
			picker: item.model_picker_enabled === true,
			policy: record(item.policy) ? item.policy.state : undefined,
		});
	}
	const picker = models.filter((model) => model.picker && model.policy !== "disabled").map((model) => model.id);
	const fallback = !picker.length && base === "https://api.individual.githubcopilot.com";
	return {
		available: fallback ? models.filter((model) => model.policy === "enabled").map((model) => model.id) : picker,
		policies: models
			.filter(
				(model) =>
					model.policy === "unconfigured" &&
					Object.hasOwn(GITHUB_COPILOT_MODELS, model.id) &&
					(model.picker || fallback),
			)
			.map((model) => model.id),
	};
}
async function tokenCredential(
	refresh: string,
	host: string | undefined,
	signal: AbortSignal,
): Promise<OAuthCredential> {
	const raw = await checkedJson(
		await fetch(`https://api.${host || "github.com"}/copilot_internal/v2/token`, {
			headers: { Accept: "application/json", Authorization: `Bearer ${refresh}`, ...headers },
			signal,
		}),
	);
	if (!record(raw)) throw new Error("Invalid Copilot token response");
	if (typeof raw.token !== "string" || typeof raw.expires_at !== "number")
		throw new Error("Invalid Copilot token response fields");
	return { type: "oauth", access: raw.token, refresh, expires: raw.expires_at * 1000 - 300000, enterpriseUrl: host };
}
async function enablePolicies(
	token: string,
	ids: string[],
	host: string | undefined,
	signal: AbortSignal,
): Promise<string[]> {
	const enabled: string[] = [];
	for (const id of ids) {
		let response: Response | undefined;
		try {
			response = await limitedFetch(
				`${endpoint(token, host)}/models/${id}/policy`,
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${token}`,
						...headers,
						"openai-intent": "chat-policy",
						"x-interaction-type": "chat-policy",
					},
					body: JSON.stringify({ state: "enabled" }),
				},
				signal,
				2,
			);
			if (response.status === 429)
				throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
			if (response.ok) enabled.push(id);
		} catch (error) {
			if (signal.aborted) throw error;
			if (response?.status === 429) break;
		}
	}
	return enabled;
}
export const githubCopilotOAuth: OAuthAuth = {
	name: "GitHub Copilot",
	isSubscription: true,
	async login(interaction) {
		const input = await interaction.prompt({
			type: "text",
			message: "GitHub Enterprise URL/domain (blank for github.com)",
			placeholder: "company.ghe.com",
		});
		if (interaction.signal.aborted) throw new Error("Login cancelled");
		const host = domain(input);
		if (input.trim() && !host) throw new Error("Invalid GitHub Enterprise URL/domain");
		const base = `https://${host || "github.com"}`;
		const form = (path: string, fields: Record<string, string>) =>
			fetch(`${base}${path}`, {
				method: "POST",
				headers: {
					Accept: "application/json",
					"Content-Type": "application/x-www-form-urlencoded",
					"User-Agent": headers["User-Agent"],
				},
				body: new URLSearchParams({ client_id: clientId, ...fields }),
				signal: interaction.signal,
			}).then(checkedJson);
		const device = await form("/login/device/code", { scope: "read:user" });
		if (!record(device)) throw new Error("Invalid device code response");
		const { device_code: code, user_code: userCode, verification_uri: uri, interval, expires_in: expires } = device;
		if (
			typeof code !== "string" ||
			typeof userCode !== "string" ||
			typeof uri !== "string" ||
			(interval !== undefined && typeof interval !== "number") ||
			typeof expires !== "number"
		)
			throw new Error("Invalid device code response fields");
		const verificationUri = trustedOAuthUrl(uri);
		if (!verificationUri) throw new Error("Untrusted verification_uri in device code response");
		interaction.notify({
			type: "device_code",
			userCode,
			verificationUri,
			intervalSeconds: interval,
			expiresInSeconds: expires,
		});
		const refresh = await pollOAuthDeviceCodeFlow<string>({
			intervalSeconds: interval,
			expiresInSeconds: expires,
			waitBeforeFirstPoll: true,
			signal: interaction.signal,
			async poll() {
				const raw = await form("/login/oauth/access_token", {
					device_code: code,
					grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				});
				if (record(raw)) {
					if (typeof raw.access_token === "string") return { status: "complete", value: raw.access_token };
					if (raw.error === "authorization_pending") return { status: "pending" };
					if (raw.error === "slow_down")
						return {
							status: "slow_down",
							intervalSeconds: typeof raw.interval === "number" ? raw.interval : undefined,
						};
					if (typeof raw.error === "string")
						return {
							status: "failed",
							message: `Device flow failed: ${raw.error}${raw.error_description ? `: ${raw.error_description}` : ""}`,
						};
				}
				return { status: "failed", message: "Invalid device token response" };
			},
		});
		const credential = await tokenCredential(refresh, host, interaction.signal);
		const catalog = await accountCatalog(credential.access, host, interaction.signal, 2);
		let enabled: string[] = [];
		if (catalog.policies.length) {
			interaction.notify({ type: "progress", message: "Enabling models..." });
			enabled = await enablePolicies(credential.access, catalog.policies, host, interaction.signal);
		}
		return { ...credential, availableModelIds: [...new Set([...catalog.available, ...enabled])] };
	},
	async refresh(credential, signal) {
		const host = enterprise(credential),
			next = await tokenCredential(credential.refresh, host, signal);
		const catalog = await accountCatalog(next.access, host, signal, 0);
		return { ...next, availableModelIds: catalog.available };
	},
	async toAuth(credential) {
		return { apiKey: credential.access, baseUrl: endpoint(credential.access, enterprise(credential)) };
	},
};
