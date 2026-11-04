import type { Principal } from "../data/index.ts";
import { defineFacet, type Facet } from "../host/index.ts";
import { defineRegistry, type ComposeContext, type RegistryTable, type TableItem } from "../registries/index.ts";
import type { Catalog } from "./messages.ts";

export type Translation = {
	readonly namespace: string;
	readonly locale: string;
	readonly messages: Catalog;
	readonly override?: true;
};
export type TranslationIndex = {
	readonly catalogs: ReadonlyMap<string, ReadonlyMap<string, TableItem<Translation>>>;
	readonly locales: readonly string[];
};
export const Translations = defineRegistry<readonly Translation[], TranslationIndex>("objects.translations", {
	version: 1,
});
export const NO_TRANSLATIONS: TranslationIndex = { catalogs: new Map(), locales: [] };
export function canonicalLocale(locale: string): string | undefined {
	try {
		return Intl.getCanonicalLocales(locale)[0];
	} catch {
		return undefined;
	}
}
export function composeTranslations(
	table: RegistryTable<readonly Translation[]>,
	context: ComposeContext,
): TranslationIndex {
	const catalogs = new Map<string, Map<string, TableItem<Translation>>>();
	const locales = new Set<string>();
	for (const contributor of table)
		for (const value of contributor.value) {
			const locale = canonicalLocale(value.locale);
			if (!locale) {
				context.report({
					message: `"${value.locale}" is no locale (${value.namespace})`,
					plugins: [contributor.plugin],
				});
				continue;
			}
			locales.add(locale);
			let group = catalogs.get(value.namespace);
			if (!group) catalogs.set(value.namespace, (group = new Map()));
			const previous = group.get(locale);
			if (!previous || (value.override && !previous.value.override))
				group.set(locale, { value, plugin: contributor.plugin });
			else if (!!value.override === !!previous.value.override)
				context.report({
					message: `${value.namespace} in ${locale} is contributed twice`,
					plugins: [previous.plugin, contributor.plugin],
				});
		}
	return { catalogs, locales: Array.from(locales).sort() };
}
export function translationsFacet<P extends Principal>(): Facet<P> {
	return defineFacet<P>((host) => host.serve(Translations, { compose: composeTranslations }));
}
