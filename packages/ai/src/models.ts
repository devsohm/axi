import { type ClientIdentity, mergeClientIdentity, getOpenCodeSessionHeaders } from "./utils/identity.ts";
import { lazyStream } from "./api/lazy.ts";
import { observeModelRequest } from "./telemetry.ts";
export { AI_TELEMETRY_SCHEMA } from "./telemetry.ts";
import { defaultProviderAuthContext } from "./auth/context.ts";
import { InMemoryCredentialStore } from "./auth/credential-store.ts";
import {
	type AuthResolutionOverrides,
	ModelsError,
	refreshStoredOAuthCredential,
	resolveProviderAuth,
} from "./auth/resolve.ts";
import type {
	AuthCheck,
	AuthContext,
	AuthInteraction,
	AuthOperationOptions,
	AuthResult,
	AuthType,
	Credential,
	CredentialStore,
	LoginOptions,
	ProviderAuth,
} from "./auth/types.ts";
import { InMemoryModelsStore, type ModelsStore, type ModelsStoreEntry } from "./models-store.ts";
import type {
	AnyModel,
	Api,
	ApiStreamOptions,
	AssistantImages,
	AssistantMessage,
	AssistantMessageEventStream,
	ClassifierApi,
	ClassifierContext,
	ClassifierModel,
	ClassifierOptions,
	ClassifierResult,
	Context,
	DeferredCancelOptions,
	DeferredFetchOptions,
	DeferredHandle,
	ImageApi,
	ImageModel,
	ImagesContext,
	ImagesOptions,
	Model,
	ModelCostRates,
	ModelThinkingLevel,
	ModelType,
	ModelTypeMap,
	ProviderClassifier,
	ProviderHeaders,
	ProviderImages,
	ProviderRequestOptions,
	ProviderStreams,
	SimpleStreamOptions,
	TranscriptContext,
	Usage,
} from "./types.ts";
import { operationSignal, raceWithAbortSignal } from "./utils/abort.ts";
import {
	assertChatModel,
	assertClassifierInputSupported,
	assertClassifierModel,
	assertImageModel,
	classifierErrorResult,
	getModelType,
	imageErrorResult,
	isModelType,
} from "./utils/model-operations.ts";
import { normalizeContext } from "./utils/transcript.ts";
export { ModelsError, type ModelsErrorCode } from "./auth/resolve.ts";
export { getModelType, isModelType } from "./utils/model-operations.ts";

export interface ModelsPublication {
	persist?: ModelsStoreEntry | null;
	update?: () => void;
}
export interface RefreshModelsContext {
	credential?: Credential;
	stored?: Readonly<ModelsStoreEntry>;
	publish(publication: ModelsPublication): Promise<boolean>;
	allowNetwork: boolean;
	force?: boolean;
	signal: AbortSignal;
	baseUrl?: string;
}
export interface ModelsRefreshOptions {
	allowNetwork?: boolean;
	providers?: readonly string[];
	force?: boolean;
	signal?: AbortSignal;
}
export interface ModelsRefreshResult {
	aborted: boolean;
	errors: ReadonlyMap<string, Error>;
}
export interface ModelsRequestTransforms {
	transformHeaders?: (headers: ProviderHeaders) => ProviderHeaders | Promise<ProviderHeaders>;
}
export type ModelsApiStreamOptions<A extends Api> = ApiStreamOptions<A> & ModelsRequestTransforms;
export type ModelsSimpleStreamOptions = SimpleStreamOptions & ModelsRequestTransforms;
export type ModelsDeferredFetchOptions = DeferredFetchOptions & ModelsRequestTransforms;
export type ModelsDeferredCancelOptions = DeferredCancelOptions & ModelsRequestTransforms;
export type ModelsImagesOptions = ImagesOptions & ModelsRequestTransforms;
export type ModelsClassifierOptions = ClassifierOptions & ModelsRequestTransforms;
type ProviderModel<A extends Api> = Model<A> | ImageModel<ImageApi> | ClassifierModel<ClassifierApi>;
export interface Provider<A extends Api = Api> {
	readonly id: string;
	readonly name: string;
	readonly baseUrl?: string;
	readonly headers?: ProviderHeaders;
	readonly auth: ProviderAuth;
	getModels(): readonly Model<A>[];
	getAllModels?(): readonly ProviderModel<A>[];
	refreshModels?(context: RefreshModelsContext): Promise<void>;
	filterModels?(models: readonly Model<A>[], credential: Credential | undefined): readonly Model<A>[];
	filterAllModels?(
		models: readonly ProviderModel<A>[],
		credential: Credential | undefined,
	): readonly ProviderModel<A>[];
	stream<T extends A>(
		model: Model<T>,
		context: TranscriptContext,
		options?: ApiStreamOptions<T>,
	): AssistantMessageEventStream;
	streamSimple(model: Model<A>, context: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream;
	fetchDeferred?(model: Model<A>, handle: DeferredHandle, options?: DeferredFetchOptions): AssistantMessageEventStream;
	cancelDeferred?(model: Model<A>, handle: DeferredHandle, options?: DeferredCancelOptions): Promise<void>;
	generateImages?(
		model: ImageModel<ImageApi>,
		context: ImagesContext,
		options?: ImagesOptions,
	): Promise<AssistantImages>;
	classify?(
		model: ClassifierModel<ClassifierApi>,
		context: ClassifierContext,
		options?: ClassifierOptions,
	): Promise<ClassifierResult>;
}
export interface Models {
	getProviders(): readonly Provider[];
	getProvider(id: string): Provider | undefined;
	getModels(provider?: string): readonly Model<Api>[];
	getModel(provider: string, id: string): Model<Api> | undefined;
	getModelsOfType<T extends ModelType>(type: T, provider?: string): readonly ModelTypeMap[T][];
	getModelOfType<T extends ModelType>(type: T, provider: string, id: string): ModelTypeMap[T] | undefined;
	getAllModels(provider?: string): readonly AnyModel[];
	refresh(options?: ModelsRefreshOptions): Promise<ModelsRefreshResult>;
	checkAuth(providerId: string, options?: AuthOperationOptions): Promise<AuthCheck | undefined>;
	getAvailable(providerId?: string, options?: AuthOperationOptions): Promise<readonly Model<Api>[]>;
	getAvailableOfType<T extends ModelType>(
		type: T,
		providerId?: string,
		options?: AuthOperationOptions,
	): Promise<readonly ModelTypeMap[T][]>;
	getAllAvailable(providerId?: string, options?: AuthOperationOptions): Promise<readonly AnyModel[]>;
	getAuth(providerId: string, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
	getAuth(model: AnyModel, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
	login(providerId: string, type: AuthType, interaction: AuthInteraction, options?: LoginOptions): Promise<Credential>;
	logout(providerId: string, options?: AuthOperationOptions): Promise<void>;
	stream<A extends Api>(
		model: Model<A>,
		context: Context,
		options?: ModelsApiStreamOptions<A>,
	): AssistantMessageEventStream;
	complete<A extends Api>(
		model: Model<A>,
		context: Context,
		options?: ModelsApiStreamOptions<A>,
	): Promise<AssistantMessage>;
	streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream;
	completeSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): Promise<AssistantMessage>;
	streamDeferred(
		model: Model<Api>,
		handle: DeferredHandle,
		options?: ModelsDeferredFetchOptions,
	): AssistantMessageEventStream;
	fetchDeferred(
		model: Model<Api>,
		handle: DeferredHandle,
		options?: ModelsDeferredFetchOptions,
	): Promise<AssistantMessage>;
	cancelDeferred(model: Model<Api>, handle: DeferredHandle, options?: ModelsDeferredCancelOptions): Promise<void>;
	generateImages(
		model: ImageModel<ImageApi>,
		context: ImagesContext,
		options?: ModelsImagesOptions,
	): Promise<AssistantImages>;
	classify(
		model: ClassifierModel<ClassifierApi>,
		context: ClassifierContext,
		options?: ModelsClassifierOptions,
	): Promise<ClassifierResult>;
}
export interface MutableModels extends Models {
	setProvider(provider: Provider): void;
	deleteProvider(id: string): void;
	clearProviders(): void;
}
export interface CreateModelsOptions {
	identity?: ClientIdentity;
	credentials?: CredentialStore;
	modelsStore?: ModelsStore;
	authContext?: AuthContext;
}
const modelTypes: Record<ModelType, true> = { chat: true, image: true, classifier: true };
function known(model: AnyModel): boolean {
	return Object.hasOwn(modelTypes, getModelType(model));
}
function mergeHeaders(
	base: ProviderHeaders | undefined,
	next: ProviderHeaders | undefined,
): ProviderHeaders | undefined {
	if (!base && !next) return undefined;
	const headers = { ...base };
	for (const [name, value] of Object.entries(next ?? {})) {
		const normalized = name.toLowerCase();
		for (const key of Object.keys(headers)) if (key.toLowerCase() === normalized) delete headers[key];
		headers[name] = value;
	}
	return headers;
}
class Collection implements MutableModels {
	readonly #providers = new Map<string, Provider>();
	readonly #credentials: CredentialStore;
	readonly #store: ModelsStore;
	readonly #auth: AuthContext;
	readonly #identity: ClientIdentity | undefined;
	readonly #generations = new Map<string, number>();
	readonly #controllers = new Map<string, AbortController>();
	readonly #publications = new Map<string, Promise<unknown>>();
	constructor(options?: CreateModelsOptions) {
		this.#credentials = options?.credentials ?? new InMemoryCredentialStore();
		this.#store = options?.modelsStore ?? new InMemoryModelsStore();
		this.#auth = options?.authContext ?? defaultProviderAuthContext();
		this.#identity = options?.identity;
	}
	#supersede(id: string): number {
		const generation = (this.#generations.get(id) ?? 0) + 1;
		this.#generations.set(id, generation);
		const previous = this.#controllers.get(id);
		this.#controllers.delete(id);
		previous?.abort();
		return generation;
	}
	setProvider(provider: Provider): void {
		this.#supersede(provider.id);
		this.#providers.set(provider.id, provider);
	}
	deleteProvider(id: string): void {
		this.#supersede(id);
		this.#providers.delete(id);
	}
	clearProviders(): void {
		for (const id of new Set([...this.#providers.keys(), ...this.#controllers.keys()])) this.#supersede(id);
		this.#providers.clear();
	}
	getProviders(): readonly Provider[] {
		return [...this.#providers.values()];
	}
	getProvider(id: string): Provider | undefined {
		return this.#providers.get(id);
	}
	getModels(id?: string): readonly Model<Api>[] {
		if (id !== undefined) {
			try {
				return this.#providers.get(id)?.getModels() ?? [];
			} catch {
				return [];
			}
		}
		const models: Model<Api>[] = [];
		for (const provider of this.#providers.values()) {
			try {
				models.push(...provider.getModels());
			} catch {}
		}
		return models;
	}
	getAllModels(id?: string): readonly AnyModel[] {
		if (id !== undefined) {
			const provider = this.#providers.get(id);
			if (!provider) return [];
			try {
				return provider.getAllModels?.() ?? provider.getModels();
			} catch {
				return [];
			}
		}
		const models: AnyModel[] = [];
		for (const provider of this.#providers.values()) {
			try {
				models.push(...(provider.getAllModels?.() ?? provider.getModels()));
			} catch {}
		}
		return models;
	}
	getModel(provider: string, id: string): Model<Api> | undefined {
		return this.getModels(provider).find((model) => model.id === id);
	}
	getModelsOfType<T extends ModelType>(type: T, provider?: string): readonly ModelTypeMap[T][] {
		return this.getAllModels(provider).filter((model): model is ModelTypeMap[T] => isModelType(model, type));
	}
	getModelOfType<T extends ModelType>(type: T, provider: string, id: string): ModelTypeMap[T] | undefined {
		return this.getModelsOfType(type, provider).find((model) => model.id === id);
	}
	#publish(id: string, generation: number, signal: AbortSignal, publication: ModelsPublication): Promise<boolean> {
		const operation = (this.#publications.get(id) ?? Promise.resolve())
			.catch(() => {})
			.then(async () => {
				const current = () => !signal.aborted && this.#generations.get(id) === generation;
				if (!current()) return false;
				if (publication.persist === null) await this.#store.delete(id, { signal });
				else if (publication.persist !== undefined)
					await this.#store.write(id, structuredClone(publication.persist), { signal });
				if (!current()) return false;
				publication.update?.();
				return true;
			});
		const tail = operation.catch(() => {});
		this.#publications.set(id, tail);
		void tail.then(() => {
			if (this.#publications.get(id) === tail) this.#publications.delete(id);
		});
		return raceWithAbortSignal(operation, signal);
	}
	async #phase(
		provider: Provider & Required<Pick<Provider, "refreshModels">>,
		credential: Credential | undefined,
		allowNetwork: boolean,
		force: boolean | undefined,
		generation: number,
		signal: AbortSignal,
	): Promise<void> {
		const stored = await this.#store.read(provider.id, { signal });
		const detached = stored ? structuredClone(stored) : undefined;
		await provider.refreshModels({
			credential,
			stored: detached ? { ...detached, models: detached.models.filter(known) } : undefined,
			allowNetwork,
			force: allowNetwork ? force : undefined,
			signal,
			baseUrl: provider.baseUrl,
			publish: (publication) => this.#publish(provider.id, generation, signal, publication),
		});
	}
	async #readCredential(id: string, signal: AbortSignal): Promise<Credential | undefined> {
		try {
			return await this.#credentials.read(id, { signal });
		} catch (cause) {
			throw new ModelsError("auth", `Credential store read failed for ${id}`, { cause });
		}
	}
	async #refreshCredential(
		provider: Provider,
		stored: Credential | undefined,
		signal: AbortSignal,
	): Promise<Credential | undefined> {
		if (stored?.type === "oauth") {
			const oauth = provider.auth.oauth;
			if (!oauth) return undefined;
			if (Date.now() < stored.expires) return stored;
			if (signal.aborted) return undefined;
			return refreshStoredOAuthCredential(
				this.#credentials,
				provider.id,
				oauth,
				(current) => Date.now() >= current.expires,
				signal,
			);
		}
		const resolved = await provider.auth.apiKey?.resolve({
			ctx: this.#auth,
			credential: stored?.type === "api_key" ? stored : undefined,
			signal,
		});
		return resolved ? { type: "api_key", key: resolved.auth.apiKey, env: resolved.env } : undefined;
	}
	async refresh(options: ModelsRefreshOptions = {}): Promise<ModelsRefreshResult> {
		const allowNetwork = options.allowNetwork ?? true;
		const caller = operationSignal(options.signal),
			errors = new Map<string, Error>();
		if (caller.aborted) return { aborted: true, errors };
		const selected = options.providers ? new Set(options.providers) : undefined;
		const providers = [...this.#providers.values()].filter(
			(provider): provider is Provider & Required<Pick<Provider, "refreshModels">> =>
				provider.refreshModels !== undefined && (!selected || selected.has(provider.id)),
		);
		const all = Promise.all(
			providers.map(async (provider) => {
				const generation = this.#supersede(provider.id),
					controller = new AbortController();
				this.#controllers.set(provider.id, controller);
				const signal = AbortSignal.any([caller, controller.signal]);
				const operation = async () => {
					let credential: Credential | undefined, failure: unknown;
					try {
						credential = await this.#readCredential(provider.id, signal);
					} catch (error) {
						failure = error;
					}
					await this.#phase(provider, credential, false, undefined, generation, signal);
					if (failure !== undefined) throw failure;
					if (!allowNetwork || signal.aborted) return;
					credential = await this.#refreshCredential(provider, credential, signal);
					if (credential) await this.#phase(provider, credential, true, options.force, generation, signal);
				};
				try {
					await raceWithAbortSignal(operation(), signal);
				} catch (cause) {
					if (!signal.aborted)
						errors.set(
							provider.id,
							cause instanceof Error
								? cause
								: new ModelsError("model_source", `Model refresh failed for ${provider.id}`, { cause }),
						);
				} finally {
					if (this.#controllers.get(provider.id) === controller) this.#controllers.delete(provider.id);
				}
			}),
		);
		try {
			await raceWithAbortSignal(all, caller);
		} catch (error) {
			if (!caller.aborted) throw error;
		}
		return { aborted: caller.aborted, errors: new Map(errors) };
	}
	async #check(
		provider: Provider,
		credential: Credential | undefined,
		signal: AbortSignal,
	): Promise<AuthCheck | undefined> {
		if (credential?.type === "oauth") return provider.auth.oauth ? { source: "OAuth", type: "oauth" } : undefined;
		if (!provider.auth.apiKey) return undefined;
		if (provider.auth.apiKey.check) {
			try {
				return await provider.auth.apiKey.check({
					ctx: this.#auth,
					credential: credential?.type === "api_key" ? credential : undefined,
					signal,
				});
			} catch (cause) {
				throw new ModelsError("auth", `API key auth check failed for provider ${provider.id}`, { cause });
			}
		}
		const resolved = await resolveProviderAuth(provider, this.#credentials, this.#auth, { signal });
		return resolved ? { type: "api_key", source: resolved.source } : undefined;
	}
	checkAuth(id: string, options?: AuthOperationOptions): Promise<AuthCheck | undefined> {
		const signal = operationSignal(options?.signal);
		const run = async () => {
			signal.throwIfAborted();
			const provider = this.#providers.get(id);
			return provider ? this.#check(provider, await this.#readCredential(id, signal), signal) : undefined;
		};
		return raceWithAbortSignal(run(), signal);
	}
	async #authenticated(id: string | undefined, signal: AbortSignal) {
		signal.throwIfAborted();
		const providers = id ? [this.#providers.get(id)].filter((provider) => provider !== undefined) : this.getProviders();
		const checked = await Promise.all(
			providers.map(async (provider) => {
				const credential = await this.#readCredential(provider.id, signal);
				return { provider, credential, auth: await this.#check(provider, credential, signal) };
			}),
		);
		return checked.filter((entry) => entry.auth !== undefined);
	}
	getAvailable(id?: string, options?: AuthOperationOptions): Promise<readonly Model<Api>[]> {
		const signal = operationSignal(options?.signal);
		const run = async () =>
			(await this.#authenticated(id, signal)).flatMap(({ provider, credential }) => {
				const models = provider.getModels();
				return provider.filterModels?.(models, credential) ?? models;
			});
		return raceWithAbortSignal(run(), signal);
	}
	getAllAvailable(id?: string, options?: AuthOperationOptions): Promise<readonly AnyModel[]> {
		const signal = operationSignal(options?.signal);
		const run = async () =>
			(await this.#authenticated(id, signal)).flatMap(({ provider, credential }) => {
				const models = provider.getAllModels?.() ?? provider.getModels();
				if (provider.filterAllModels) return provider.filterAllModels(models, credential);
				if (!provider.filterModels) return models;
				const ids = new Set(provider.filterModels(provider.getModels(), credential).map((model) => model.id));
				return models.filter((model) => !isModelType(model, "chat") || ids.has(model.id));
			});
		return raceWithAbortSignal(run(), signal);
	}
	async getAvailableOfType<T extends ModelType>(
		type: T,
		id?: string,
		options?: AuthOperationOptions,
	): Promise<readonly ModelTypeMap[T][]> {
		return (await this.getAllAvailable(id, options)).filter((model): model is ModelTypeMap[T] =>
			isModelType(model, type),
		);
	}
	async getAuth(input: string | AnyModel, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined> {
		const id = typeof input === "string" ? input : input.provider,
			provider = this.#providers.get(id);
		if (!provider) return undefined;
		const result = await resolveProviderAuth(provider, this.#credentials, this.#auth, {
			...overrides,
			signal: operationSignal(overrides?.signal),
		});
		return result && typeof input !== "string" && input.headers
			? { ...result, auth: { ...result.auth, headers: mergeHeaders(result.auth.headers, input.headers) } }
			: result;
	}
	async login(id: string, type: AuthType, interaction: AuthInteraction, options?: LoginOptions): Promise<Credential> {
		const signal = operationSignal(interaction.signal);
		signal.throwIfAborted();
		const provider = this.#providers.get(id);
		if (!provider) throw new ModelsError("provider", `Unknown provider: ${id}`);
		const method = type === "oauth" ? provider.auth.oauth : provider.auth.apiKey;
		if (!method?.login) throw new ModelsError("auth", `${provider.name} does not support ${type} login`);
		const credential = await raceWithAbortSignal<Credential>(method.login({ ...interaction, signal }, options), signal);
		let started = false;
		const admission = Promise.withResolvers<void>();
		const mutation = this.#credentials.modify(
			id,
			async () => {
				started = true;
				admission.resolve();
				return credential;
			},
			{ signal },
		);
		void mutation.catch(() => {});
		try {
			await new Promise<void>((resolve, reject) => {
				const cancel = () => {
					if (!started) reject(signal.reason);
				};
				signal.addEventListener("abort", cancel, { once: true });
				void Promise.race([admission.promise, mutation]).then(
					() => {
						signal.removeEventListener("abort", cancel);
						resolve();
					},
					(error) => {
						signal.removeEventListener("abort", cancel);
						reject(error);
					},
				);
				if (signal.aborted) cancel();
			});
			await mutation;
		} catch (cause) {
			signal.throwIfAborted();
			throw new ModelsError("auth", `Credential store modify failed for ${id}`, { cause });
		}
		return credential;
	}
	async logout(id: string, options?: AuthOperationOptions): Promise<void> {
		const signal = operationSignal(options?.signal);
		signal.throwIfAborted();
		try {
			await this.#credentials.delete(id, { signal });
		} catch (cause) {
			signal.throwIfAborted();
			throw new ModelsError("auth", `Credential store delete failed for ${id}`, { cause });
		}
	}
	#require(model: AnyModel): Provider {
		const provider = this.#providers.get(model.provider);
		if (!provider) throw new ModelsError("provider", `Unknown provider: ${model.provider}`);
		return provider;
	}
	#chat(model: Model<Api>): Provider {
		assertChatModel(model);
		return this.#require(model);
	}
	async #apply<M extends AnyModel, O extends ProviderRequestOptions<M> & ModelsRequestTransforms>(
		model: M,
		options: O | undefined,
	): Promise<{ requestModel: M; requestOptions: Omit<O, "transformHeaders"> & ProviderRequestOptions<M> }> {
		this.#require(model);
		const resolved = await this.getAuth(model, { apiKey: options?.apiKey, env: options?.env, signal: options?.signal });
		if (!resolved) throw new ModelsError("auth", `Provider is not configured: ${model.provider}`);
		const apiKey = options?.apiKey ?? resolved.auth.apiKey;
		const requestModel: M = resolved.auth.baseUrl ? { ...model, baseUrl: resolved.auth.baseUrl } : model;
		const sessionId =
			options && "sessionId" in options && typeof options.sessionId === "string" ? options.sessionId : undefined;
		let headers = mergeHeaders(
			mergeHeaders(getOpenCodeSessionHeaders(requestModel, sessionId), resolved.auth.headers),
			options?.headers,
		);
		if (options?.transformHeaders) headers = await options.transformHeaders(headers ?? {});
		const env = resolved.env || options?.env ? { ...resolved.env, ...options?.env } : undefined;
		const { transformHeaders: _transform, ...rest } = options ?? {};
		return {
			requestModel,
			requestOptions: {
				...rest,
				apiKey,
				headers,
				env,
				identity: mergeClientIdentity(this.#identity, options?.identity),
			} as Omit<O, "transformHeaders"> & ProviderRequestOptions<M>,
		};
	}
	stream<A extends Api>(
		model: Model<A>,
		context: Context,
		options?: ModelsApiStreamOptions<A>,
	): AssistantMessageEventStream {
		const transcript = normalizeContext(context);
		return lazyStream(
			model,
			async () => {
				const provider = this.#chat(model);
				const { requestModel, requestOptions } = await this.#apply(
					model,
					options as ModelsApiStreamOptions<Api> | undefined,
				);
				return provider.stream(requestModel, transcript, requestOptions as ApiStreamOptions<A>);
			},
			observeModelRequest(model, options, false),
		);
	}
	async complete<A extends Api>(
		model: Model<A>,
		context: Context,
		options?: ModelsApiStreamOptions<A>,
	): Promise<AssistantMessage> {
		return this.stream(model, context, options).result();
	}
	streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream {
		const transcript = normalizeContext(context);
		return lazyStream(
			model,
			async () => {
				const provider = this.#chat(model);
				const { requestModel, requestOptions } = await this.#apply(model, options);
				return provider.streamSimple(requestModel, transcript, requestOptions as SimpleStreamOptions);
			},
			observeModelRequest(model, options, false),
		);
	}
	async completeSimple(
		model: Model<Api>,
		context: Context,
		options?: ModelsSimpleStreamOptions,
	): Promise<AssistantMessage> {
		return this.streamSimple(model, context, options).result();
	}
	streamDeferred(
		model: Model<Api>,
		handle: DeferredHandle,
		options?: ModelsDeferredFetchOptions,
	): AssistantMessageEventStream {
		return lazyStream(
			model,
			async () => {
				const provider = this.#chat(model);
				if (!provider.fetchDeferred)
					throw new ModelsError("provider", `Provider ${model.provider} does not support deferred responses`);
				const { requestModel, requestOptions } = await this.#apply(model, options);
				return provider.fetchDeferred(requestModel, handle, requestOptions);
			},
			observeModelRequest(model, options, true),
		);
	}
	async fetchDeferred(
		model: Model<Api>,
		handle: DeferredHandle,
		options?: ModelsDeferredFetchOptions,
	): Promise<AssistantMessage> {
		return this.streamDeferred(model, handle, options).result();
	}
	async cancelDeferred(
		model: Model<Api>,
		handle: DeferredHandle,
		options?: ModelsDeferredCancelOptions,
	): Promise<void> {
		const provider = this.#chat(model);
		if (!provider.cancelDeferred)
			throw new ModelsError("provider", `Provider ${model.provider} does not support deferred responses`);
		const { requestModel, requestOptions } = await this.#apply(model, options);
		await provider.cancelDeferred(requestModel, handle, requestOptions);
	}
	async generateImages(
		model: ImageModel<ImageApi>,
		context: ImagesContext,
		options?: ModelsImagesOptions,
	): Promise<AssistantImages> {
		try {
			assertImageModel(model);
			const provider = this.#require(model);
			if (!provider.generateImages)
				throw new ModelsError("provider", `Provider ${model.provider} does not support image generation`);
			const { requestModel, requestOptions } = await this.#apply(model, options);
			return await provider.generateImages(requestModel, context, requestOptions);
		} catch (error) {
			return imageErrorResult(model, error, options?.signal?.aborted);
		}
	}
	async classify(
		model: ClassifierModel<ClassifierApi>,
		context: ClassifierContext,
		options?: ModelsClassifierOptions,
	): Promise<ClassifierResult> {
		try {
			assertClassifierModel(model);
			assertClassifierInputSupported(model, context);
			const provider = this.#require(model);
			if (!provider.classify)
				throw new ModelsError("provider", `Provider ${model.provider} does not support classification`);
			const { requestModel, requestOptions } = await this.#apply(model, options);
			return await provider.classify(requestModel, context, requestOptions);
		} catch (error) {
			return classifierErrorResult(model, error, options?.signal?.aborted);
		}
	}
}
export function createModels(options?: CreateModelsOptions): MutableModels {
	return new Collection(options);
}
export interface CreateProviderOptions<A extends Api = Api> {
	id: string;
	name?: string;
	baseUrl?: string;
	headers?: ProviderHeaders;
	auth: ProviderAuth;
	models: readonly ProviderModel<A>[];
	fetchModels?: (context: RefreshModelsContext) => Promise<readonly ProviderModel<A>[]>;
	filterModels?: (models: readonly Model<A>[], credential: Credential | undefined) => readonly Model<A>[];
	filterAllModels?: (
		models: readonly ProviderModel<A>[],
		credential: Credential | undefined,
	) => readonly ProviderModel<A>[];
	api?: ProviderStreams | Partial<Record<A, ProviderStreams>>;
	images?: Partial<Record<ImageApi, ProviderImages>>;
	classifiers?: Partial<Record<ClassifierApi, ProviderClassifier>>;
}
export function createProvider<A extends Api = Api>(input: CreateProviderOptions<A>): Provider<A> {
	const single =
		input.api && typeof (input.api as ProviderStreams).stream === "function"
			? (input.api as ProviderStreams)
			: undefined;
	const byApi = single || !input.api ? undefined : (input.api as Partial<Record<string, ProviderStreams>>);
	const images = input.images,
		classifiers = input.classifiers;
	const streams = single ? [single] : Object.values(byApi ?? {}).filter((api) => api !== undefined);
	const imageImplementations = Object.values(images ?? {}).filter((api) => api !== undefined);
	const classifierImplementations = Object.values(classifiers ?? {}).filter((api) => api !== undefined);
	if (!streams.length && !imageImplementations.length && !classifierImplementations.length)
		throw new Error(`Provider ${input.id}: at least one of "api", "images", or "classifiers" is required.`);
	const baselineModels = input.models;
	let overlay: readonly ProviderModel<A>[] = [];
	const all = () => {
		const models = [...baselineModels];
		for (const model of overlay) {
			const index = models.findIndex(
				(existing) => getModelType(existing) === getModelType(model) && existing.id === model.id,
			);
			if (index < 0) models.push(model);
			else models[index] = model;
		}
		return models;
	};
	const implementation = (model: Model<Api>) => single ?? byApi?.[model.api];
	const dispatch = (model: Model<Api>, run: (api: ProviderStreams) => AssistantMessageEventStream) => {
		const api = implementation(model);
		return api
			? run(api)
			: lazyStream(model, async () => {
					throw new ModelsError("stream", `Provider ${input.id} has no API implementation for "${model.api}"`);
				});
	};
	const fetch = input.fetchModels;
	const provider: Provider<A> = {
		id: input.id,
		name: input.name ?? input.id,
		baseUrl: input.baseUrl,
		headers: input.headers,
		auth: input.auth,
		getModels: () => all().filter((model): model is Model<A> => isModelType(model, "chat")),
		getAllModels: all,
		refreshModels: fetch
			? async (context) => {
					if (context.stored) {
						const restored = context.stored.models.filter((model) => model.provider === input.id) as ProviderModel<A>[];
						if (
							!(await context.publish({
								update: () => {
									overlay = restored;
								},
							}))
						)
							return;
					}
					if (!context.allowNetwork || context.signal.aborted) return;
					const result = await fetch(context);
					if (context.signal.aborted) return;
					const models = result.filter(known);
					await context.publish({
						persist: { models, checkedAt: Date.now() },
						update: () => {
							overlay = models;
						},
					});
				}
			: undefined,
		filterModels: input.filterModels,
		filterAllModels: input.filterAllModels,
		stream: (model, context, options) => dispatch(model, (api) => api.stream(model, context, options)),
		streamSimple: (model, context, options) => dispatch(model, (api) => api.streamSimple(model, context, options)),
	};
	if (streams.some((api) => api.fetchDeferred !== undefined))
		provider.fetchDeferred = (model, handle, options) =>
			lazyStream(model, async () => {
				const api = implementation(model);
				if (!api?.fetchDeferred)
					throw new ModelsError(
						"provider",
						`Provider ${input.id} does not support deferred responses for "${model.api}"`,
					);
				return api.fetchDeferred(model, handle, options);
			});
	if (streams.some((api) => api.cancelDeferred !== undefined))
		provider.cancelDeferred = async (model, handle, options) => {
			const api = implementation(model);
			if (!api?.cancelDeferred)
				throw new ModelsError("provider", `Provider ${input.id} cannot cancel deferred responses for "${model.api}"`);
			await api.cancelDeferred(model, handle, options);
		};
	if (images && imageImplementations.length)
		provider.generateImages = async (model, context, options) => {
			const api = images[model.api];
			return api
				? api.generateImages(model, context, options)
				: imageErrorResult(
						model,
						new ModelsError(
							"provider",
							`Provider ${input.id} has no image generation implementation for "${model.api}"`,
						),
					);
		};
	if (classifiers && classifierImplementations.length)
		provider.classify = async (model, context, options) => {
			const api = classifiers[model.api];
			return api
				? api.classify(model, context, options)
				: classifierErrorResult(
						model,
						new ModelsError("provider", `Provider ${input.id} has no classifier implementation for "${model.api}"`),
					);
		};
	return provider;
}
export function hasApi<A extends Api>(model: AnyModel, api: A): model is Model<A> {
	return isModelType(model, "chat") && model.api === api;
}
export function calculateCost(model: AnyModel, usage: Usage): Usage["cost"] {
	let rates: ModelCostRates = model.cost,
		threshold = -1;
	const tokens = usage.input + usage.cacheRead + usage.cacheWrite;
	for (const tier of model.cost.tiers ?? [])
		if (tokens > tier.inputTokensAbove && tier.inputTokensAbove > threshold) {
			rates = tier;
			threshold = tier.inputTokensAbove;
		}
	usage.cost.input = (rates.input / 1_000_000) * usage.input;
	usage.cost.output = (rates.output / 1_000_000) * usage.output;
	usage.cost.cacheRead = (rates.cacheRead / 1_000_000) * usage.cacheRead;
	const long = usage.cacheWrite1h ?? 0;
	usage.cost.cacheWrite = (rates.cacheWrite * (usage.cacheWrite - long) + rates.input * 2 * long) / 1_000_000;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	usage.cost.totalFromProvider = false;
	return usage.cost;
}
const levels: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export function getSupportedThinkingLevels<A extends Api>(model: Model<A>): ModelThinkingLevel[] {
	return !model.reasoning
		? ["off"]
		: levels.filter((level) => {
				const mapped = model.thinkingLevelMap?.[level];
				return mapped !== null && ((level !== "xhigh" && level !== "max") || mapped !== undefined);
			});
}
export function clampThinkingLevel<A extends Api>(model: Model<A>, level: ModelThinkingLevel): ModelThinkingLevel {
	const supported = getSupportedThinkingLevels(model);
	if (supported.includes(level)) return level;
	const index = levels.indexOf(level);
	if (index < 0) return supported[0] ?? "off";
	for (let position = index; position < levels.length; position++)
		if (supported.includes(levels[position])) return levels[position];
	for (let position = index - 1; position >= 0; position--)
		if (supported.includes(levels[position])) return levels[position];
	return supported[0] ?? "off";
}
export function modelsAreEqual(a: AnyModel | null | undefined, b: AnyModel | null | undefined): boolean {
	return !!a && !!b && getModelType(a) === getModelType(b) && a.id === b.id && a.provider === b.provider;
}
