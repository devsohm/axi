import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import { constant, createHost, createLanguage, defineMessages, FALLBACK_THEMES, hostLanguage, hostKind } from "../src/index.ts";
import { HostProvider, useMessages, usePageState, watchStore } from "../src/react/index.ts";
import { NO_TRANSLATIONS } from "../src/surfaces/translations.ts";
import { SandboxChannel } from "../src/tui/channel.ts";
import { BridgeTerminal } from "../src/tui/terminal.ts";
import { TuiScope } from "../src/tui/scope.ts";
import { TerminalTheme } from "../src/tui/theme.ts";
import { FRAME_UNITS, splitFrames } from "../src/tui/frames.ts";
import type { Bridge, LauncherMessage, SandboxMessage } from "../src/tui/bridge.ts";
import { filterOutput } from "../src/node/tui/filter.ts";
import { createPlugins } from "../src/node/plugins/index.ts";
import { createHttp } from "../src/node/http/index.ts";
import { WEB_PREFIX, pageScripts, webSurface } from "../src/node/surfaces/index.ts";

it("renders React bindings with the host's language and retained page state", async () => {
	const host = createHost({ onError() {} });
	await host.load([], context);
	try {
		const messages = defineMessages("view", { en: { title: "View" }, es: { title: "Vista" } });
		hostLanguage(host).set(createLanguage("es", NO_TRANSLATIONS, () => {}));
		function View() {
			const { t } = useMessages(messages),
				[value] = usePageState("selected", 3);
			return createElement("p", null, `${t("title")} ${value}`);
		}
		expect(renderToStaticMarkup(createElement(HostProvider, { host }, createElement(View)))).toBe("<p>Vista 3</p>");
		const source = constant(4),
			store = watchStore(source),
			changed = vi.fn(),
			unsubscribe = store.subscribe(changed);
		expect(store.snapshot()).toBe(4);
		await vi.waitFor(() => expect(changed).toHaveBeenCalled());
		unsubscribe();
		expect(watchStore(undefined).snapshot()).toBeUndefined();
	} finally {
		await host.close(context);
	}
});

it("disposes terminal scopes without losing host state or retaining redraw subscriptions", async () => {
	const host = createHost({ onError() {} });
	await host.load([], context);
	try {
		const changed = vi.fn(),
			scope = new TuiScope(host, changed),
			state = scope.pageState("draft", "");
		const messages = defineMessages("view", { en: { title: "View" }, es: { title: "Vista" } }),
			t = scope.messages(messages);
		state.set("saved");
		hostLanguage(host).set(createLanguage("es", NO_TRANSLATIONS, () => {}));
		expect(t("title")).toBe("Vista");
		expect(changed).toHaveBeenCalledTimes(2);
		scope.dispose();
		state.set("later");
		expect(changed).toHaveBeenCalledTimes(2);
		const next = new TuiScope(host, () => {});
		expect(next.pageState("draft", "").read()).toBe("later");
		next.dispose();
		const theme = new TerminalTheme(FALLBACK_THEMES.dark, "truecolor"),
			listener = vi.fn(),
			stop = theme.onChange(listener);
		theme.set(FALLBACK_THEMES.light);
		stop();
		theme.set(FALLBACK_THEMES.dark);
		expect(listener).toHaveBeenCalledTimes(1);
		expect(theme.fg("accent", "x")).toContain("\x1b[38;2;");
	} finally {
		await host.close(context);
	}
});

it("relays terminal input, sockets and confirmed action replies across the bridge", async () => {
	const sent: SandboxMessage[] = [];
	let receive!: (message: LauncherMessage) => void;
	const bridge: Bridge = {
		start: { base: "1", combined: "", columns: 80, rows: 24, colors: "256", mode: "dark", locales: ["en"] },
		send: (message) => sent.push(message),
		onMessage: (listener) => {
			receive = listener;
		},
		evaluate() {},
	};
	const channel = new SandboxChannel(bridge),
		terminal = new BridgeTerminal(channel),
		input = vi.fn(),
		resized = vi.fn();
	terminal.onInput(input);
	terminal.onResize(resized);
	receive({ kind: "input", data: "a" });
	receive({ kind: "resize", columns: 100, rows: 40 });
	expect(input).toHaveBeenCalledWith("a");
	expect(terminal.columns).toBe(100);
	expect(terminal.rows).toBe(40);
	expect(resized).toHaveBeenCalledOnce();
	const link = channel.openSocket({ opened() {}, received() {} }),
		frame = new Uint8Array([1, 2]);
	link.send(frame);
	expect(sent).toEqual([{ kind: "socket_open", socket: 1 }]);
	receive({ kind: "socket_opened", socket: 1 });
	expect(sent.at(-1)).toEqual({ kind: "socket_send", socket: 1, bytes: frame });
	const message = vi.fn();
	link.onMessage(message);
	receive({ kind: "socket_message", socket: 1, bytes: frame });
	expect(message).toHaveBeenCalledWith(frame);
	const action = channel.request({ kind: "copy", text: "text" });
	receive({ kind: "reply", id: 2, value: true });
	await expect(action).resolves.toBe(true);
	link.close();
	expect(sent.at(-1)).toEqual({ kind: "socket_close", socket: 1 });
});

it("splits large paints between complete escapes and removes untrusted terminal controls", () => {
	const paint = "\x1b[38;2;20;30;40mé😀".repeat(4000),
		frames = splitFrames(paint);
	expect(frames.join("")).toBe(paint);
	expect(frames.length).toBeGreaterThan(1);
	for (const frame of frames) {
		expect(frame.length).toBeLessThanOrEqual(FRAME_UNITS);
		expect(filterOutput(frame)).toBe(frame);
	}
	expect(filterOutput("ok\x1b]52;c;c2VjcmV0\x07safe\x1b[?9h")).toBe("oksafe");
	expect(filterOutput("a\x9d52;c;hidden\x9cb")).toBe("ab");
	expect(() => filterOutput("x".repeat(65537))).toThrow("64 KiB");
});

it("publishes a content-addressed browser bundle through real HTTP routing", async () => {
	const directory = await mkdtemp(join(tmpdir(), "axi-surface-"));
	const host = createHost({ address: hostKind("server")(), principal: { kind: "server" }, onError() {} }),
		plugins = createPlugins(
			{ roots: [], kinds: { web: { platform: "browser", hostPackages: [] } }, onError() {} },
			context,
		);
	const http = createHttp(host, { onError() {} }, context);
	try {
		const entry = join(directory, "main.ts");
		await writeFile(entry, "globalThis.started = true;");
		const surface = await webSurface(
			host,
			{ plugins, entry, public: true, page: (request, assets) => pageScripts(assets, request.nonce) },
			context,
		);
		const loaded = await host.load(
			[
				{ name: "http", facet: http.facet },
				{ name: "web", facet: surface.facet },
			],
			context,
		);
		expect(loaded.failed).toEqual([]);
		const request = (path: string) =>
			http.fetch(new Request(`http://127.0.0.1${path}`, { headers: { host: "127.0.0.1" } }), {
				localAddress: "127.0.0.1",
				localPort: 80,
			});
		const page = await request("/");
		expect(page.status).toBe(200);
		expect(await page.text()).toContain("globalThis.objectsPage");
		const base = await request(`${WEB_PREFIX}base`);
		expect(await base.json()).toBe(surface.base);
		const script = await request(`${WEB_PREFIX}base.${surface.base}.js`);
		expect(script.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
		expect(await script.text()).toContain("globalThis.started=!0");
	} finally {
		await http.close(context);
		await host.close(context);
		plugins.close();
		await rm(directory, { recursive: true, force: true });
	}
});
