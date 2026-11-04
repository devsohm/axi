import { canonicalLocale, type TranslationIndex } from "./translations.ts";

export type MessagesReport =
	| {
			readonly kind: "fallback";
			readonly namespace: string;
			readonly locale: string;
			readonly key: string;
			readonly used: string | undefined;
	  }
	| {
			readonly kind: "failed";
			readonly namespace: string;
			readonly locale: string;
			readonly key: string;
			readonly plugin: string | undefined;
			readonly error: unknown;
	  }
	| { readonly kind: "unknown"; readonly namespace: string; readonly key: string; readonly expected: string };
export type Language = {
	readonly locale: string;
	readonly dir: "ltr" | "rtl";
	readonly chain: readonly string[];
	readonly translations: TranslationIndex;
	readonly report: (report: MessagesReport) => void;
};
function bases(locale: string): string[] {
	const result = [locale];
	for (let end = locale.lastIndexOf("-"); end >= 0; end = locale.lastIndexOf("-", end - 1))
		result.push(locale.slice(0, end));
	return result;
}
const rtl = new Set("Adlm Arab Hebr Mand Nkoo Rohg Samr Syrc Thaa Yezi".split(" "));
export function createLanguage(locale: string, translations: TranslationIndex, report: Language["report"]): Language {
	return {
		locale,
		translations,
		report,
		chain: bases(locale),
		dir: rtl.has(new Intl.Locale(locale).maximize().script ?? "") ? "rtl" : "ltr",
	};
}
let active: Language | undefined;
export function currentLanguage(): Language | undefined {
	return active;
}
export function inLanguage<T>(language: Language | undefined, render: () => T): T {
	const saved = active;
	try {
		active = language;
		return render();
	} finally {
		active = saved;
	}
}
export function matchLocale(preferred: readonly string[], offered: readonly string[]): string | undefined {
	for (const tag of preferred) {
		const locale = canonicalLocale(tag);
		if (!locale) continue;
		for (const candidate of bases(locale)) if (offered.includes(candidate)) return candidate;
		const related = offered.find((candidate) => candidate.split("-")[0] === locale.split("-")[0]);
		if (related) return related;
	}
	return undefined;
}
export function resolveLocale(pick: string | null, preferred: readonly string[], offered: readonly string[]): string {
	const explicit = pick === null ? undefined : matchLocale([pick], offered);
	return explicit ?? matchLocale(preferred, offered) ?? (offered.includes("en") ? "en" : offered[0]) ?? "en";
}
