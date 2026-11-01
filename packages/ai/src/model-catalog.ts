import type {
	Api,
	ClassifierApi,
	ClassifierModel,
	ImageApi,
	ImageModel,
	Model,
	ModelType,
	ProviderId,
} from "./types.ts";

export type ModelGroups = Record<string, Record<string, object>>;
type CatalogKeys<G extends ModelGroups> = { [A in keyof G]: keyof G[A] }[keyof G] & string;
type Id<K extends string> = K extends `${ModelType}:${infer I}` ? I : never;
type Route<G extends ModelGroups, K extends string> = { [A in keyof G]: K extends keyof G[A] ? A : never }[keyof G];

export type ChatModelCatalog<G extends ModelGroups, P extends ProviderId> = {
	[K in Extract<CatalogKeys<G>, `chat:${string}`> as Id<K>]: Model<Route<G, K> & Api> & { id: Id<K>; provider: P };
};
export type ImageModelCatalog<G extends ModelGroups, P extends ProviderId> = {
	[K in Extract<CatalogKeys<G>, `image:${string}`> as Id<K>]: ImageModel<Route<G, K> & ImageApi> & {
		id: Id<K>;
		provider: P;
	};
};
export type ClassifierModelCatalog<G extends ModelGroups, P extends ProviderId> = {
	[K in Extract<CatalogKeys<G>, `classifier:${string}`> as Id<K>]: ClassifierModel<Route<G, K> & ClassifierApi> & {
		id: Id<K>;
		provider: P;
	};
};

function select(groups: ModelGroups, type: ModelType): Record<string, object> {
	return Object.fromEntries(
		Object.values(groups)
			.flatMap((group) => Object.values(group))
			.filter((model) => (model as { type?: unknown }).type === type)
			.map((model) => [(model as { id: string }).id, model]),
	);
}

export function flattenChatModelCatalog<const P extends ProviderId, const G extends ModelGroups>(
	_provider: P,
	groups: G,
): ChatModelCatalog<G, P> {
	return select(groups, "chat") as ChatModelCatalog<G, P>;
}
export function flattenImageModelCatalog<const P extends ProviderId, const G extends ModelGroups>(
	_provider: P,
	groups: G,
): ImageModelCatalog<G, P> {
	return select(groups, "image") as ImageModelCatalog<G, P>;
}
export function flattenClassifierModelCatalog<const P extends ProviderId, const G extends ModelGroups>(
	_provider: P,
	groups: G,
): ClassifierModelCatalog<G, P> {
	return select(groups, "classifier") as ClassifierModelCatalog<G, P>;
}
