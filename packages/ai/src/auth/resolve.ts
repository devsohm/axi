import type { ProviderEnv } from "../types.ts";
import { operationSignal, raceWithAbortSignal } from "../utils/abort.ts";
import { ModelsError } from "../utils/models-error.ts";
import type {
	ApiKeyCredential,
	AuthContext,
	AuthResult,
	Credential,
	CredentialStore,
	OAuthAuth,
	OAuthCredential,
	ProviderAuth,
} from "./types.ts";
export { ModelsError, type ModelsErrorCode } from "../utils/models-error.ts";
export interface AuthResolutionOverrides {
	apiKey?: string;
	env?: ProviderEnv;
	minOAuthValidityMs?: number;
	signal?: AbortSignal;
}
export async function refreshStoredOAuthCredential(
	store: CredentialStore,
	providerId: string,
	oauth: OAuthAuth,
	needsRefresh: (credential: OAuthCredential) => boolean,
	signal: AbortSignal,
): Promise<OAuthCredential | undefined> {
	const waiting = new AbortController();
	const cancel = () => waiting.abort(signal.reason);
	signal.addEventListener("abort", cancel, { once: true });
	if (signal.aborted) cancel();
	try {
		const current = await store.modify(
			providerId,
			async (credential) => {
				signal.removeEventListener("abort", cancel);
				signal.throwIfAborted();
				if (credential?.type !== "oauth" || !needsRefresh(credential)) return undefined;
				try {
					return await oauth.refresh(credential, AbortSignal.timeout(15_000));
				} catch (cause) {
					throw new ModelsError("oauth", `OAuth refresh failed for ${providerId}`, { cause });
				}
			},
			{ signal: waiting.signal },
		);
		return current?.type === "oauth" ? current : undefined;
	} catch (cause) {
		if (cause instanceof ModelsError) throw cause;
		signal.throwIfAborted();
		throw new ModelsError("auth", `Credential store modify failed for ${providerId}`, { cause });
	} finally {
		signal.removeEventListener("abort", cancel);
	}
}
export function resolveProviderAuth(
	provider: { id: string; auth: ProviderAuth },
	store: CredentialStore,
	context: AuthContext,
	overrides?: AuthResolutionOverrides,
): Promise<AuthResult | undefined> {
	const signal = operationSignal(overrides?.signal);
	const operation = async (): Promise<AuthResult | undefined> => {
		signal.throwIfAborted();
		const env = overrides?.env;
		const requestContext: AuthContext = env
			? {
					env: async (name) => env[name] || (await context.env(name)),
					fileExists: (path) => context.fileExists(path),
				}
			: context;
		async function apiKey(credential?: ApiKeyCredential): Promise<AuthResult | undefined> {
			try {
				return await provider.auth.apiKey?.resolve({ ctx: requestContext, credential, signal });
			} catch (cause) {
				throw new ModelsError("auth", `API key auth failed for provider ${provider.id}`, { cause });
			}
		}
		if (overrides?.apiKey !== undefined && provider.auth.apiKey)
			return apiKey({ type: "api_key", key: overrides.apiKey, env: overrides.env });
		let stored: Credential | undefined;
		try {
			stored = await store.read(provider.id, { signal });
		} catch (cause) {
			throw new ModelsError("auth", `Credential store read failed for ${provider.id}`, { cause });
		}
		if (!stored) return provider.auth.apiKey ? apiKey() : undefined;
		if (stored.type === "api_key")
			return provider.auth.apiKey
				? apiKey(overrides?.env ? { ...stored, env: { ...stored.env, ...overrides.env } } : stored)
				: undefined;
		const oauth = provider.auth.oauth;
		if (stored.type !== "oauth" || !oauth) return undefined;
		const margin = Math.max(300_000, overrides?.minOAuthValidityMs ?? 0);
		const expiring = (credential: OAuthCredential) => Date.now() + margin >= credential.expires;
		let credential = stored;
		if (expiring(stored)) {
			const refreshed = await refreshStoredOAuthCredential(store, provider.id, oauth, expiring, signal);
			if (!refreshed) return undefined;
			credential = refreshed;
			if (overrides?.minOAuthValidityMs !== undefined && expiring(credential))
				throw new ModelsError("oauth", `OAuth refresh returned a token that expires too soon for ${provider.id}`);
		}
		try {
			return { auth: await oauth.toAuth(credential), source: "OAuth" };
		} catch (cause) {
			throw new ModelsError("oauth", `OAuth auth derivation failed for ${provider.id}`, { cause });
		}
	};
	return raceWithAbortSignal(operation(), signal);
}
