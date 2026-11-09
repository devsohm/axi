import { currentLanguage, type Language } from "./language.ts";
const defaults = new WeakMap<Language, { time: Intl.DateTimeFormat; number: Intl.NumberFormat }>();
function cached(language: Language) {
	let value = defaults.get(language);
	if (!value) {
		value = {
			time: new Intl.DateTimeFormat(language.locale, { timeStyle: "short" }),
			number: new Intl.NumberFormat(language.locale),
		};
		defaults.set(language, value);
	}
	return value;
}
export function formatTime(at: Date | number | string, options?: Intl.DateTimeFormatOptions): string {
	const lang = currentLanguage();
	return (
		lang && options === undefined
			? cached(lang).time
			: new Intl.DateTimeFormat(lang?.locale, options ?? { timeStyle: "short" })
	).format(new Date(at));
}
export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
	const lang = currentLanguage();
	return (lang && options === undefined ? cached(lang).number : new Intl.NumberFormat(lang?.locale, options)).format(
		value,
	);
}
