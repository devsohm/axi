import { arr, bool, nul, num, obj, str, union } from "../contracts/index.ts";
import { checkName } from "../contracts/names.ts";
import { currentLanguage, inLanguage, type Language } from "./language.ts";
import { canonicalLocale, type Translation } from "./translations.ts";

export type MessageValue = string | ((...args: never[]) => string);
export type Catalog = { readonly [key: string]: MessageValue };
export type CatalogShape<M> = { readonly [K in keyof M]: M[K] extends string ? string : M[K] };
export type MessageArgs<V> = V extends (...args: infer A) => string ? A : [];
export type MessageParam = string | number | boolean | null;
export type MessageData<N extends string = string, K extends string = string> = {
	readonly namespace: N;
	readonly key: K;
	readonly params: MessageParam[];
};
export const MessageSchema = obj({ namespace: str(), key: str(), params: arr(union([str(), num(), bool(), nul()])) });
export type DataKeys<M> = {
	[K in keyof M & string]: MessageArgs<M[K]> extends readonly MessageParam[] ? K : never;
}[keyof M & string];
type Namespace<G extends MessageData, N extends string> = string extends G["namespace"]
	? unknown
	: { readonly namespace: N };
export type Translator<N extends string, M> = {
	<K extends keyof M & string>(key: K, ...args: MessageArgs<M[K]>): string;
	render<G extends MessageData>(message: G & Namespace<G, N>): string;
};
export type Messages<N extends string, M> = Translator<N, M> & {
	readonly namespace: N;
	readonly translations: readonly Translation[];
	message<K extends DataKeys<M>>(key: K, ...args: MessageArgs<M[K]>): MessageData<N, K>;
	in(language: Language | undefined): Translator<N, M>;
};
export type MessagesOf<T> = T extends Messages<string, infer M> ? M : never;

function invoke(value: MessageValue | undefined, args: readonly unknown[]): string {
	return typeof value === "string" ? value : Reflect.apply(value!, undefined, args);
}
export function defineMessages<const N extends string, M extends Catalog>(
	namespace: N,
	catalogs: { readonly [locale: string]: CatalogShape<M> },
): Messages<N, CatalogShape<M>> {
	checkName(namespace, "A messages namespace");
	const byLocale = new Map<string, Catalog>();
	for (const [tag, catalog] of Object.entries(catalogs)) {
		const canonical = canonicalLocale(tag);
		if (!canonical) throw new Error(`${namespace}: "${tag}" is no language tag`);
		byLocale.set(canonical, catalog);
	}
	const first = byLocale.values().next().value;
	if (!first) throw new Error(`${namespace}: defineMessages needs a catalog`);
	function text(language: Language | undefined, key: string, args: readonly unknown[]): string {
		if (!language) return invoke(first![key], args);
		return inLanguage(language, () => {
			const result = (index: number, value: string): string => {
				if (index !== 0)
					language.report({ kind: "fallback", namespace, locale: language.locale, key, used: language.chain[index] });
				return value;
			};
			for (let index = 0; index < language.chain.length; index++) {
				const locale = language.chain[index]!;
				const contribution = language.translations.catalogs.get(namespace)?.get(locale);
				if (contribution && Object.hasOwn(contribution.value.messages, key)) {
					try {
						return result(index, invoke(contribution.value.messages[key], args));
					} catch (error) {
						language.report({ kind: "failed", namespace, key, locale, plugin: contribution.plugin, error });
					}
				}
				const own = byLocale.get(locale);
				if (own && own !== contribution?.value.messages && Object.hasOwn(own, key))
					return result(index, invoke(own[key], args));
			}
			return result(language.chain.length, invoke(first![key], args));
		});
	}
	function bind(read: () => Language | undefined): Translator<N, CatalogShape<M>> {
		return Object.assign((key: string, ...args: unknown[]) => text(read(), key, args), {
			render(message: MessageData) {
				const language = read();
				const { namespace: received, key, params } = message;
				if (received !== namespace || !Object.hasOwn(first!, key) || !Array.isArray(params)) {
					language?.report({ kind: "unknown", namespace: received, key, expected: namespace });
					return key;
				}
				try {
					return text(language, key, params);
				} catch (error) {
					if (language)
						language.report({
							kind: "failed",
							namespace: received,
							locale: language.locale,
							key,
							plugin: undefined,
							error,
						});
					return key;
				}
			},
		}) as Translator<N, CatalogShape<M>>;
	}
	return Object.assign(bind(currentLanguage), {
		namespace,
		translations: Array.from(byLocale, ([locale, messages]) => ({ namespace, locale, messages })),
		message: (key: string, ...params: MessageParam[]) => ({ namespace, key, params }),
		in: (language: Language | undefined) => bind(() => language),
	}) as Messages<N, CatalogShape<M>>;
}
