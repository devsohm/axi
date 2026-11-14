import { expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import {
	activeTheme,
	createHost,
	createLanguage,
	defineFacet,
	defineMessages,
	evaluateRegistered,
	FALLBACK_THEMES,
	formatNumber,
	hostKind,
	keepConnected,
	LocaleChoice,
	localeChoiceFacet,
	LoadedFacets,
	memoryLinkPair,
	openStore,
	sqliteBackend,
	startClient,
	terminalColor,
	Translations,
	translationsFacet,
	WebScripts,
	type RegisteredScript,
	type ScriptSet,
} from "../src/index.ts";
import { openNodeSqliteDatabase } from "../src/sqlite/node.ts";
import { composeTranslations } from "../src/surfaces/translations.ts";
import { inLanguage } from "../src/surfaces/language.ts";
import { pageState } from "../src/surfaces/page-state.ts";
import { publishTo, scriptsFacet } from "../src/node/surfaces/current.ts";
import type { LoopOptions } from "../src/surfaces/connection.ts";

it("renders contributed catalogs, fallbacks and linked message data in a scoped locale", () => {
	const messages = defineMessages("tasks", {
		en: { empty: "No tasks", count: (n: number) => `${formatNumber(n)} tasks` },
		fr: { empty: "Aucune tâche", count: (n: number) => `${formatNumber(n)} tâches` },
	});
	const reports: unknown[] = [];
	const translations = composeTranslations(
		[{ plugin: "locale", version: 1, value: [{ namespace: "tasks", locale: "fr-CA", messages: { empty: "Vide" } }] }],
		{ report: (event) => reports.push(event) },
	);
	const language = createLanguage("fr-CA", translations, (event) => reports.push(event));
	expect(messages.in(language)("empty")).toBe("Vide");
	expect(messages.in(language)("count", 1234)).toBe(`${new Intl.NumberFormat("fr-CA").format(1234)} tâches`);
	expect(reports).toContainEqual({ kind: "fallback", namespace: "tasks", locale: "fr-CA", key: "count", used: "fr" });
	expect(messages.in(language).render(messages.message("empty"))).toBe("Vide");
	expect(messages.in(language).render({ namespace: "foreign", key: "absent", params: [] } as never)).toBe("absent");
	expect(inLanguage(language, () => messages("empty"))).toBe("Vide");
	expect(messages("empty")).toBe("No tasks");
});

it("reports catalog conflicts and recovers from a failing contributed translation", () => {
	const reports: unknown[] = [];
	const index = composeTranslations(
		[
			{ plugin: "a", version: 1, value: [{ namespace: "tasks", locale: "de", messages: { title: "first" } }] },
			{
				plugin: "b",
				version: 1,
				value: [
					{ namespace: "tasks", locale: "de", messages: { title: "second" } },
					{ namespace: "tasks", locale: "bad tag", messages: {} },
				],
			},
			{
				plugin: "c",
				version: 1,
				value: [
					{
						namespace: "tasks",
						locale: "de",
						override: true,
						messages: {
							title() {
								throw Error("broken");
							},
						},
					},
				],
			},
		],
		{ report: (event) => reports.push(event) },
	);
	const messages = defineMessages("tasks", { en: { title: "Tasks" }, de: { title: "Aufgaben" } });
	expect(messages.in(createLanguage("de", index, (event) => reports.push(event)))("title")).toBe("Aufgaben");
	expect(reports).toHaveLength(3);
	expect(() => defineMessages("tasks", {})).toThrow("needs a catalog");
	expect(() => defineMessages("tasks", { "invalid tag": { title: "x" } })).toThrow("no language tag");
});

it("keeps page state scoped to a host and unsubscribes its readers", async () => {
	const host = createHost({ onError() {} });
	await host.load([], context);
	try {
		const state = pageState(host, "selection", { line: 1 }),
			changed = vi.fn();
		const stop = state.subscribe(changed),
			value = { line: 2 };
		state.set(value);
		state.set(value);
		stop();
		state.set({ line: 3 });
		expect(changed).toHaveBeenCalledTimes(1);
		expect(pageState(host, "selection", null).read()).toEqual({ line: 3 });
	} finally {
		await host.close(context);
	}
});

it("reports duplicate plugin names before the loaded-set cache can merge them", async () => {
	const host = createHost({ onError() {} });
	const entries = ["first", "second"].map((digest) => ({
		name: "repeated",
		digest,
		prepare: () => ({ kind: "facet" as const, digest, facet: defineFacet(() => {}) }),
	}));
	try {
		const { report } = await LoadedFacets.load(host, [], entries, context);
		expect(report.failed).toEqual([
			{ plugin: "repeated", error: expect.objectContaining({ message: 'plugin "repeated" is loaded twice' }) },
		]);
	} finally {
		await host.close(context);
	}
});

it("stores locale choices through the remote contract and restores them after reacquisition", async () => {
	const database = await openNodeSqliteDatabase(":memory:");
	const store = await openStore(sqliteBackend(database), context);
	const server = createHost<{ kind: "server" } | { kind: "user"; id: string }>({
		address: hostKind("server")(),
		principal: { kind: "server" },
		store,
		onError() {},
	});
	const client = createHost({ onError() {} });
	await server.load([{ name: "locale", facet: localeChoiceFacet() }], context);
	await client.load([], context);
	const [local, remote] = memoryLinkPair();
	server.accept(remote, { principal: { kind: "user", id: "one" } }, context);
	client.connect(local, { principal: { kind: "server" } }, context);
	try {
		const choice = await client.get(LocaleChoice, {}, context);
		expect(choice.pick.value).toBeNull();
		await choice.choose("de", context);
		choice.release();
		const again = await client.get(LocaleChoice, {}, context);
		expect(again.pick.value).toBe("de");
		await expect(again.choose("invalid tag", context)).rejects.toMatchObject({ code: "invalid" });
		again.release();
	} finally {
		await client.close(context);
		await server.close(context);
		await store.close(context);
	}
});

it("uses theme choices and terminal overrides with deterministic fallback", () => {
	const theme = { ...FALLBACK_THEMES.dark, id: "mine", tui: { accent: "208" } };
	expect(activeTheme([theme], { dark: "mine", light: null }, "dark")).toBe(theme);
	expect(activeTheme([], { dark: null, light: null }, "light")).toBe(FALLBACK_THEMES.light);
	expect(terminalColor(theme, "accent", "truecolor", "fg")).toBe("38;5;208");
	expect(terminalColor({ ...theme, colors: { ...theme.colors, error: "#ff0000" } }, "error", "256", "fg")).toBe(
		"38;5;196",
	);
	expect(terminalColor(theme, "unknown", "256", "bg")).toBe("49");
});

it("reconnects with backoff and cancels its timeout when stopped", async () => {
	vi.useFakeTimers();
	let closed: (() => void) | undefined;
	const opens = vi.fn(() => ({
		close() {
			closed?.();
		},
		onClose(fn: () => void) {
			closed = fn;
		},
	}));
	const handle = keepConnected({
		open: opens,
		onState() {},
		canRetry: async () => true,
		environment: {
			now: () => Date.now(),
			online: () => true,
			onWake: () => () => {},
			after(ms, fn) {
				const timer = setTimeout(fn, ms);
				return () => clearTimeout(timer);
			},
		},
	});
	try {
		closed?.();
		await vi.advanceTimersByTimeAsync(249);
		expect(opens).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(opens).toHaveBeenCalledTimes(2);
		handle.stop();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(opens).toHaveBeenCalledTimes(2);
	} finally {
		handle.stop();
		vi.useRealTimers();
	}
});

it("keeps connection hook receivers and reads the current retry callback after a disconnect", async () => {
	const receivers: unknown[] = [];
	let closed: (() => void) | undefined;
	let originalRetries = 0;
	const link = {
		onClose(fn: () => void) {
			closed = fn;
		},
		close() {
			closed?.();
		},
	};
	const options = {
		open: function (this: unknown) {
			receivers.push(this);
			return link;
		},
		onState: function (this: unknown) {
			receivers.push(this);
		},
		canRetry: async () => {
			originalRetries++;
			return false;
		},
		environment: {
			now: Date.now,
			online: () => true,
			onWake: () => () => {},
			after(ms, fn) {
				const timer = setTimeout(fn, ms);
				return () => clearTimeout(timer);
			},
		},
	} satisfies LoopOptions;
	const handle = keepConnected(options);
	try {
		options.canRetry = async function (this: unknown) {
			receivers.push(this);
			return false;
		};
		link.close();
		await Promise.resolve();
		expect(originalRetries).toBe(0);
		expect(receivers).toEqual([options, options, options, options]);
	} finally {
		handle.stop();
	}
});

it("retries a failed script download and retains a facet when replacement evaluation fails", async () => {
	const server = createHost({ address: hostKind("server")(), principal: { kind: "server" }, onError() {} });
	const script = (digest: string, broken = false): RegisteredScript => ({
		plugin: "example",
		digest,
		run(_require, module) {
			if (broken) throw Error("bad update");
			module.exports = {
				default: defineFacet((_host, self) =>
					self.contribute(Translations, [{ namespace: "sample", locale: "en", messages: { value: digest } }]),
				),
			};
		},
	});
	const set = (item: RegisteredScript): ScriptSet => ({
		base: "stable",
		combined: "/all.js",
		plugins: [{ name: item.plugin, digest: item.digest, url: "/one.js" }],
	});
	const first = script("one"),
		second = script("two"),
		failed = script("three", true),
		errors: unknown[] = [];
	let attempts = 0;
	await server.load([{ name: "scripts", facet: scriptsFacet("web", { set: set(first) }) }], context);
	const client = await startClient({
		scripts: WebScripts,
		base: "stable",
		initial: [first],
		modules: {},
		core: [{ name: "translations", facet: translationsFacet() }],
		fetchScript: async (entry) => {
			if (entry.digest !== "two") return failed;
			if (++attempts === 1) throw new Error("download interrupted");
			return second;
		},
		serverBase: async () => "stable",
		outdated() {},
		onError: (event) => errors.push(event),
		environment: {
			now: () => Date.now(),
			online: () => true,
			onWake: () => () => {},
			after(ms, fn) {
				const timer = setTimeout(fn, ms);
				return () => clearTimeout(timer);
			},
		},
		open(events) {
			const [mine, theirs] = memoryLinkPair();
			server.accept(theirs, { principal: { kind: "user" } }, context);
			queueMicrotask(events.opened);
			return mine;
		},
	});
	try {
		const registry = await client.host.registry(Translations, context);
		await publishTo(server, "web", set(second), context);
		await vi.waitFor(() => expect(registry.value.catalogs.get("sample")?.get("en")?.value.messages.value).toBe("two"), {
			timeout: 3000,
		});
		expect(attempts).toBe(2);
		expect(errors).toContainEqual(expect.objectContaining({ kind: "update_failed" }));
		await publishTo(server, "web", set(failed), context);
		await vi.waitFor(() => expect(errors).toContainEqual(expect.objectContaining({ kind: "plugins" })));
		expect(registry.value.catalogs.get("sample")?.get("en")?.value.messages.value).toBe("two");
		expect(() =>
			evaluateRegistered(
				{
					...first,
					run(require) {
						require("node:fs");
					},
				},
				{},
			),
		).toThrow("host packages");
	} finally {
		await client.stop(context);
		await server.close(context);
	}
});
