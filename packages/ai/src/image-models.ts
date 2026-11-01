import { IMAGE_MODELS } from "./models.generated.ts";
import type { ImageApi, ImageModel } from "./types.ts";
type Catalog = typeof IMAGE_MODELS;
type Id<P extends keyof Catalog> = keyof Catalog[P];
export type BuiltinImageProvider = { [P in keyof Catalog]: [Id<P>] extends [never] ? never : P }[keyof Catalog];
type Entry<P extends BuiltinImageProvider, I extends Id<P>> = Catalog[P][I] extends ImageModel<infer A extends ImageApi>
	? ImageModel<A>
	: never;
const catalogs = new Map<string, Map<string, ImageModel<ImageApi>>>();
for (const [provider, models] of Object.entries(IMAGE_MODELS)) {
	const entries = new Map<string, ImageModel<ImageApi>>();
	for (const model of Object.values(models)) entries.set(model.id, model);
	if (entries.size > 0) catalogs.set(provider, entries);
}
export function getImageModel<P extends BuiltinImageProvider, I extends Id<P>>(provider: P, id: I): Entry<P, I> {
	return catalogs.get(provider)?.get(id as string) as Entry<P, I>;
}
export function getImageModels<P extends BuiltinImageProvider>(provider: P): Entry<P, Id<P>>[] {
	return Array.from(catalogs.get(provider)?.values() ?? []) as Entry<P, Id<P>>[];
}
export function getImageProviders(): BuiltinImageProvider[] {
	return [...catalogs.keys()] as BuiltinImageProvider[];
}
