import type { OAuthClientMetadataDocument, OAuthClientProvider } from "./flow.ts";
import type {
	AuthorizationServerMetadata,
	OAuthClientInformationMixed,
	OAuthClientMetadata,
	OAuthDiscoveryState,
	OAuthTokens,
} from "./types.ts";
export interface McpOAuthState {
	serverUrl: string;
	clientInformation?: OAuthClientInformationMixed;
	tokens?: OAuthTokens;
	tokensExpireAt?: number;
	codeVerifier?: string;
	oauthState?: string;
	discovery?: OAuthDiscoveryState;
}
export interface McpOAuthStateStore {
	load(): McpOAuthState | undefined | Promise<McpOAuthState | undefined>;
	save(state: McpOAuthState): void | Promise<void>;
}
export interface McpOAuthProviderOptions {
	serverUrl: string | URL;
	redirectUrl: string | URL;
	clientMetadata: Omit<OAuthClientMetadata, "redirect_uris"> & { redirect_uris?: string[] };
	clientMetadataDocument?: (
		metadata: AuthorizationServerMetadata | undefined,
	) => OAuthClientMetadataDocument | undefined;
	clientId?: string;
	clientSecret?: string;
	store?: McpOAuthStateStore;
	onRedirect(url: URL): void | Promise<void>;
}
export class MemoryOAuthStateStore implements McpOAuthStateStore {
	#value?: McpOAuthState;
	load(): McpOAuthState | undefined {
		return this.#value === undefined ? undefined : structuredClone(this.#value);
	}
	save(state: McpOAuthState): void {
		this.#value = structuredClone(state);
	}
}
export class McpOAuthProvider implements OAuthClientProvider {
	readonly redirectUrl: string;
	readonly clientMetadata: OAuthClientMetadata;
	readonly clientMetadataDocument?: (
		metadata: AuthorizationServerMetadata | undefined,
	) => OAuthClientMetadataDocument | undefined;
	readonly #server: string;
	readonly #store: McpOAuthStateStore;
	readonly #configured?: OAuthClientInformationMixed;
	readonly #redirect: McpOAuthProviderOptions["onRedirect"];
	#tail = Promise.resolve();
	constructor(options: McpOAuthProviderOptions) {
		this.#server = String(new URL(options.serverUrl));
		this.redirectUrl = String(options.redirectUrl);
		this.clientMetadata = {
			...options.clientMetadata,
			redirect_uris: options.clientMetadata.redirect_uris ?? [this.redirectUrl],
			grant_types: options.clientMetadata.grant_types ?? ["authorization_code", "refresh_token"],
			response_types: options.clientMetadata.response_types ?? ["code"],
			token_endpoint_auth_method:
				options.clientMetadata.token_endpoint_auth_method ?? (options.clientSecret ? "client_secret_post" : "none"),
		};
		this.clientMetadataDocument = options.clientMetadataDocument;
		this.#configured = options.clientId
			? { client_id: options.clientId, ...(options.clientSecret ? { client_secret: options.clientSecret } : {}) }
			: undefined;
		this.#store = options.store ?? new MemoryOAuthStateStore();
		this.#redirect = options.onRedirect;
	}
	#own(value?: McpOAuthState): McpOAuthState {
		return value?.serverUrl === this.#server ? value : { serverUrl: this.#server };
	}
	async #load(): Promise<McpOAuthState> {
		await this.#tail;
		return this.#own(await this.#store.load());
	}
	async #update(change: (state: McpOAuthState) => McpOAuthState): Promise<void> {
		this.#tail = this.#tail.then(async () => {
			await this.#store.save(change(this.#own(await this.#store.load())));
		});
		await this.#tail;
	}
	async state(): Promise<string> {
		const existing = (await this.#load()).oauthState;
		if (existing) return existing;
		const value = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
		await this.#update((state) => ({ ...state, oauthState: value }));
		return value;
	}
	async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
		return this.#configured ?? (await this.#load()).clientInformation;
	}
	async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
		if (!this.#configured) await this.#update((state) => ({ ...state, clientInformation }));
	}
	async tokens(): Promise<OAuthTokens | undefined> {
		return (await this.#load()).tokens;
	}
	async saveTokens(tokens: OAuthTokens): Promise<void> {
		const expiry = tokens.expires_in === undefined ? undefined : Date.now() + tokens.expires_in * 1000;
		await this.#update((state) => {
			const next = { ...state, tokens };
			if (expiry === undefined) delete next.tokensExpireAt;
			else next.tokensExpireAt = expiry;
			return next;
		});
	}
	async redirectToAuthorization(url: URL): Promise<void> {
		await this.#redirect(url);
	}
	async saveCodeVerifier(codeVerifier: string): Promise<void> {
		await this.#update((state) => ({ ...state, codeVerifier }));
	}
	async codeVerifier(): Promise<string> {
		const value = (await this.#load()).codeVerifier;
		if (!value) throw new Error("No OAuth PKCE code verifier is stored");
		return value;
	}
	async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
		return (await this.#load()).discovery;
	}
	async saveDiscoveryState(discovery: OAuthDiscoveryState): Promise<void> {
		await this.#update((state) => ({ ...state, discovery }));
	}
	async invalidateCredentials(kind: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
		await this.#update((state) => {
			const next = { ...state };
			if (kind === "all" || kind === "client") delete next.clientInformation;
			if (kind === "all" || kind === "tokens") {
				delete next.tokens;
				delete next.tokensExpireAt;
			}
			if (kind === "all" || kind === "verifier") delete next.codeVerifier;
			if (kind === "all" || kind === "discovery") delete next.discovery;
			if (kind === "all") delete next.oauthState;
			return next;
		});
	}
}
