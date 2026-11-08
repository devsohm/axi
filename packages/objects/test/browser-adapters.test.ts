import { afterEach, expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import {
	createHost,
	defineFacet,
	FALLBACK_THEMES,
	Themes,
	themesFacet,
	Translations,
	translationsFacet,
} from "../src/index.ts";
import { REGISTER } from "../src/surfaces/registered.ts";
import { pageEnvironment } from "../src/web/environment.ts";
import { followLanguage } from "../src/web/language.ts";
import { PageScripts } from "../src/web/scripts.ts";
import { followThemes } from "../src/web/themes.ts";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

test("browser script loading accepts only the registered plugin and digest and cleans up every outcome", async () => {
	const elements: Script[] = [];
	class Script extends EventTarget {
		src = "";
		removed = false;
		remove() {
			this.removed = true;
		}
	}
	vi.stubGlobal("document", {
		createElement: (name: string) => {
			expect(name).toBe("script");
			return new Script();
		},
		head: { append: (script: Script) => elements.push(script) },
	});
	const run = () => {},
		initial = { base: "base", queued: [["initial", "1", run]] as const, styles: {}, links: {}, watching() {} };
	const scripts = new PageScripts(initial);
	expect(scripts.base).toBe("base");
	expect(scripts.initial).toEqual([{ plugin: "initial", digest: "1", run }]);
	try {
		const pending = scripts.fetch({ name: "example", digest: "2", url: "/two.js" });
		const register = Reflect.get(globalThis, REGISTER);
		if (typeof register !== "function") throw new Error("Missing registration callback");
		register("example", "wrong", run);
		expect(elements[0]?.removed).toBe(false);
		register("example", "2", run);
		expect(await pending).toEqual({ plugin: "example", digest: "2", run });
		expect(elements[0]?.removed).toBe(true);
		elements[0]!.dispatchEvent(new Event("load"));
		const unregistered = scripts.fetch({ name: "example", digest: "3", url: "/three.js" });
		elements[1]!.dispatchEvent(new Event("load"));
		await expect(unregistered).rejects.toThrow(/did not register 3/);
		const failed = scripts.fetch({ name: "example", digest: "4", url: "/four.js" });
		elements[2]!.dispatchEvent(new Event("error"));
		await expect(failed).rejects.toThrow(/did not load/);
		expect(elements.every((element) => element.removed)).toBe(true);
	} finally {
		Reflect.deleteProperty(globalThis, REGISTER);
	}
});

test("the browser environment wakes only on restored pages, visible tabs and connectivity changes", () => {
	vi.useFakeTimers();
	const window = new EventTarget(),
		document = Object.assign(new EventTarget(), { visibilityState: "hidden" });
	const network = new EventTarget(),
		navigator = { onLine: false, connection: network };
	vi.stubGlobal("window", window);
	vi.stubGlobal("document", document);
	vi.stubGlobal("navigator", navigator);
	const environment = pageEnvironment(),
		wake = vi.fn(),
		tick = vi.fn();
	expect(environment.online()).toBe(false);
	navigator.onLine = true;
	expect(environment.online()).toBe(true);
	expect(environment.now()).toBe(Date.now());
	const stop = environment.onWake(wake);
	window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: false }));
	document.dispatchEvent(new Event("visibilitychange"));
	expect(wake).not.toHaveBeenCalled();
	window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
	window.dispatchEvent(new Event("online"));
	network.dispatchEvent(new Event("change"));
	document.visibilityState = "visible";
	document.dispatchEvent(new Event("visibilitychange"));
	expect(wake).toHaveBeenCalledTimes(4);
	const cancel = environment.after(10, tick);
	cancel();
	environment.after(20, tick);
	vi.advanceTimersByTime(20);
	expect(tick).toHaveBeenCalledOnce();
	stop();
	window.dispatchEvent(new Event("online"));
	network.dispatchEvent(new Event("change"));
	document.dispatchEvent(new Event("visibilitychange"));
	expect(wake).toHaveBeenCalledTimes(4);
});

test("browser language and theme adapters update DOM properties and release browser listeners", async () => {
	const host = createHost({ onError() {} }),
		browser = new EventTarget();
	const variables = new Map<string, string>();
	const element = {
		lang: "",
		dir: "",
		style: {
			colorScheme: "",
			setProperty: (name: string, value: string) => variables.set(name, value),
			removeProperty: (name: string) => variables.delete(name),
		},
	};
	const media = Object.assign(new EventTarget(), { matches: true });
	const navigator = { languages: ["ar"] };
	vi.stubGlobal("document", { documentElement: element });
	vi.stubGlobal("navigator", navigator);
	vi.stubGlobal("matchMedia", () => media);
	vi.stubGlobal("addEventListener", browser.addEventListener.bind(browser));
	vi.stubGlobal("removeEventListener", browser.removeEventListener.bind(browser));
	const translations = defineFacet((_host, self) =>
		self.contribute(Translations, [
			{ namespace: "app", locale: "ar", messages: {} },
			{ namespace: "app", locale: "en", messages: {} },
		]),
	);
	const dark = { ...FALLBACK_THEMES.dark, id: "dark", web: { extra: "red" } };
	const colors = defineFacet((_host, self) => self.contribute(Themes, dark));
	await host.load(
		[
			{ name: "themes", facet: themesFacet() },
			{ name: "translations", facet: translationsFacet() },
			{ name: "catalog", facet: translations },
			{ name: "colors", facet: colors },
		],
		context,
	);
	let stopLanguage = () => {},
		stopTheme = () => {};
	try {
		stopLanguage = await followLanguage(host, () => {}, context);
		stopTheme = await followThemes(host, context);
		expect([element.lang, element.dir]).toEqual(["ar", "rtl"]);
		expect(element.style.colorScheme).toBe("dark");
		expect(variables.get("--extra")).toBe("red");
		navigator.languages = ["en-US"];
		browser.dispatchEvent(new Event("languagechange"));
		expect([element.lang, element.dir]).toEqual(["en", "ltr"]);
		media.matches = false;
		media.dispatchEvent(new Event("change"));
		expect(element.style.colorScheme).toBe("light");
		expect(variables.has("--extra")).toBe(false);
		stopLanguage();
		stopTheme();
		navigator.languages = ["ar"];
		browser.dispatchEvent(new Event("languagechange"));
		media.matches = true;
		media.dispatchEvent(new Event("change"));
		expect([element.lang, element.dir, element.style.colorScheme]).toEqual(["en", "ltr", "light"]);
	} finally {
		stopLanguage();
		stopTheme();
		await host.close(context);
	}
});
