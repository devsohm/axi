import { withAbortSignal, type Context } from "../context/index.ts";
import type { Principal } from "../data/index.ts";
import type { Host } from "../host/index.ts";
import { createLanguage, resolveLocale, type Language, type MessagesReport } from "./language.ts";
import { LocaleChoice } from "./locale-choice.ts";
import { pageState, type PageState } from "./page-state.ts";
import { NO_TRANSLATIONS, Translations } from "./translations.ts";

export type LanguageFollower = { setDevice(preferred: readonly string[]): void; stop(): void };
export function hostLanguage<P extends Principal>(host: Host<P>): PageState<Language | undefined> {
	return pageState<Language | undefined, P>(host, "objects.language", undefined);
}
export async function followActiveLanguage<P extends Principal>(
	host: Host<P>,
	preferred: readonly string[],
	changed: (language: Language) => void,
	report: (report: MessagesReport) => void,
	context: Context,
): Promise<LanguageFollower> {
	const controller = new AbortController(),
		ctx = withAbortSignal(controller.signal, context);
	const state = hostLanguage(host),
		reports = new Set<string>();
	let catalogs = NO_TRANSLATIONS,
		pick: string | null = null,
		device = preferred;
	const reportDistinct = (event: MessagesReport): void => {
		const key = `${event.kind}|${event.namespace}|${"locale" in event ? event.locale : ""}|${event.key}`;
		if (!reports.has(key)) {
			reports.add(key);
			report(event);
		}
	};
	const update = (): void => {
		const locale = resolveLocale(pick, device, catalogs.locales),
			current = state.read();
		if (current?.locale === locale && current.translations === catalogs) return;
		const language = createLanguage(locale, catalogs, reportDistinct);
		state.set(language);
		changed(language);
	};
	update();
	const registry = await host.registry(Translations, ctx);
	catalogs = registry.value;
	update();
	(await registry.watch(ctx)).start(async (frame) => {
		if (frame.kind === "value") catalogs = frame.value;
		update();
	});
	const choice = host.hold(LocaleChoice, {}, ctx);
	void choice.pick.watch(ctx).then(
		(feed) =>
			feed.start(async (frame) => {
				if (frame.kind === "value") pick = frame.value;
				update();
			}),
		() => {},
	);
	return {
		setDevice(next) {
			device = next;
			update();
		},
		stop() {
			controller.abort();
			choice.release();
		},
	};
}
