import { expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import {
	createHost,
	defineFacet,
	defineMessages,
	FALLBACK_THEMES,
	hostKind,
	LocaleChoice,
	localeChoiceFacet,
	ThemeChoice,
	themeChoiceFacet,
	Themes,
	themesFacet,
	Translations,
	translationsFacet,
	type Theme,
	type Principal,
	openStore,
	sqliteBackend,
} from "../src/index.ts";
import { followActiveLanguage, hostLanguage } from "../src/surfaces/active-language.ts";
import { openNodeSqliteDatabase } from "../src/sqlite/node.ts";
import { followActiveTheme } from "../src/surfaces/active-theme.ts";

test("language follows device preferences, user choices and updated catalogs, then stops watching", async () => {
	const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context);
	const host = createHost<Principal>({
		store,
		address: hostKind("server")(),
		principal: { kind: "user", id: "reader" },
		onError() {},
	});
	const contribution = (title: string) =>
		defineFacet((_facet, self) =>
			self.contribute(Translations, [
				{ namespace: "view", locale: "fr", messages: { title } },
				{ namespace: "view", locale: "de", messages: { title: "Ansicht" } },
			]),
		);
	const core = [
		{ name: "translations", facet: translationsFacet() },
		{ name: "locale", facet: localeChoiceFacet() },
	];
	await host.load([...core, { name: "catalog", facet: contribution("Vue") }], context);
	const changed = vi.fn(),
		reports = vi.fn();
	const messages = defineMessages("view", { en: { title: "View", extra: "Extra" } });
	try {
		const follower = await followActiveLanguage(host, ["fr-CA"], changed, reports, context);
		try {
			await vi.waitFor(() => expect(hostLanguage(host).read()?.locale).toBe("fr"));
			const current = hostLanguage(host).read();
			if (!current) throw new Error("Expected a language");
			expect(messages.in(current)("title")).toBe("Vue");
			messages.in(current)("extra");
			messages.in(current)("extra");
			expect(reports.mock.calls.filter(([event]) => event.key === "extra")).toHaveLength(1);
			const count = changed.mock.calls.length;
			follower.setDevice(["fr"]);
			expect(changed).toHaveBeenCalledTimes(count);
			follower.setDevice(["de"]);
			expect(hostLanguage(host).read()?.locale).toBe("de");
			const choice = await host.get(LocaleChoice, {}, context);
			try {
				await choice.choose("fr", context);
				await vi.waitFor(() => expect(hostLanguage(host).read()?.locale).toBe("fr"));
				await host.reload([...core, { name: "catalog", facet: contribution("Nouvelle vue") }], context);
				await vi.waitFor(() => {
					const language = hostLanguage(host).read();
					expect(language && messages.in(language)("title")).toBe("Nouvelle vue");
				});
				follower.stop();
				const settled = changed.mock.calls.length;
				await choice.choose("de", context);
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect(changed).toHaveBeenCalledTimes(settled);
			} finally {
				choice.release();
			}
		} finally {
			follower.stop();
		}
	} finally {
		await host.close(context);
		await store.close(context);
	}
});

test("theme follows mode, persisted user selection and registry reload without updates after stop", async () => {
	const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context);
	const host = createHost<Principal>({
		store,
		address: hostKind("server")(),
		principal: { kind: "user", id: "reader" },
		onError() {},
	});
	const dark: Theme = { ...FALLBACK_THEMES.dark, id: "night", name: "Night" };
	const alternative: Theme = { ...dark, id: "z-alternative", name: "Alternative" };
	const light: Theme = { ...FALLBACK_THEMES.light, id: "day", name: "Day" };
	const core = [
		{ name: "themes", facet: themesFacet() },
		{ name: "choice", facet: themeChoiceFacet() },
	];
	const contributions = (theme: Theme) =>
		[dark, theme, light].map((value) => ({
			name: value.id,
			facet: defineFacet((_facet, self) => self.contribute(Themes, value)),
		}));
	await host.load([...core, ...contributions(alternative)], context);
	const changed = vi.fn();
	try {
		const follower = await followActiveTheme(host, "dark", changed, context);
		try {
			await vi.waitFor(() => expect(changed).toHaveBeenLastCalledWith(dark));
			follower.setMode("light");
			expect(changed).toHaveBeenLastCalledWith(light);
			const choice = await host.get(ThemeChoice, {}, context);
			try {
				await choice.choose({ dark: "z-alternative", light: "day" }, context);
				follower.setMode("dark");
				await vi.waitFor(() => expect(changed).toHaveBeenLastCalledWith(alternative));
				await host.reload([...core, ...contributions({ ...alternative, name: "Updated" })], context);
				await vi.waitFor(() => expect(changed).toHaveBeenLastCalledWith({ ...alternative, name: "Updated" }));
				follower.stop();
				const settled = changed.mock.calls.length;
				await choice.choose({ dark: "night", light: null }, context);
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect(changed).toHaveBeenCalledTimes(settled);
			} finally {
				choice.release();
			}
		} finally {
			follower.stop();
		}
	} finally {
		await host.close(context);
		await store.close(context);
	}
});
