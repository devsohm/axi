import { once } from "node:events";
import { WebSocketServer } from "ws";
import { afterEach, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import { createHost, defineFacet, hostKind, Translations, webSocketLink } from "../src/index.ts";
import { scriptsFacet } from "../src/node/surfaces/current.ts";
import { REGISTER } from "../src/surfaces/registered.ts";
import type { ConnectionState } from "../src/surfaces/connection.ts";
import { telemetryIngestFacet, type TelemetryBatch } from "../src/telemetry-ingest/index.ts";
import { startPage } from "../src/web/page.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

it("refuses a page without its server bootstrap before connecting or rendering", async () => {
	vi.stubGlobal("objectsPage", undefined);
	const connect = vi.fn(),
		render = vi.fn();
	await expect(startPage({ connect, render, modules: {} })).rejects.toThrow("no Objects bootstrap");
	expect(connect).not.toHaveBeenCalled();
	expect(render).not.toHaveBeenCalled();
});

it.each([
	{ telemetry: false, themes: undefined, follow: undefined },
	{ telemetry: true, themes: undefined, follow: undefined },
	{ telemetry: false, themes: false, follow: undefined },
	{ telemetry: false, themes: false, follow: false },
])(
	"boots and reconnects a page with telemetry=$telemetry, themes=$themes, follow=$follow",
	async ({ telemetry, themes, follow }) => {
		const browser = new EventTarget();
		const element = { lang: "", dir: "", style: { colorScheme: "", setProperty() {}, removeProperty() {} } };
		const document = Object.assign(new EventTarget(), {
			visibilityState: "visible",
			documentElement: element,
			querySelectorAll: () => [],
		});
		const watching = vi.fn(),
			removed = vi.spyOn(document, "removeEventListener"),
			reload = vi.fn();
		vi.stubGlobal("window", browser);
		vi.stubGlobal("document", document);
		vi.stubGlobal("navigator", { languages: ["en"], onLine: true });
		vi.stubGlobal("matchMedia", () => Object.assign(new EventTarget(), { matches: true }));
		vi.stubGlobal("addEventListener", browser.addEventListener.bind(browser));
		vi.stubGlobal("removeEventListener", browser.removeEventListener.bind(browser));
		vi.stubGlobal("location", { reload });
		vi.stubGlobal(REGISTER, undefined);
		vi.stubGlobal("objectsPage", { base: "initial", styles: {}, links: {}, watching, queued: [] });
		const fetchBase = vi.fn(async () => {
			if (!telemetry) throw new Error("Server offline");
			return new Response(JSON.stringify("updated"));
		});
		vi.stubGlobal("fetch", fetchBase);
		const intervals: ReturnType<typeof setInterval>[] = [],
			startInterval = globalThis.setInterval;
		vi.spyOn(globalThis, "setInterval").mockImplementation((callback, delay) => {
			const interval = startInterval(callback, delay);
			if (delay === 3000) intervals.push(interval);
			return interval;
		});
		const batches: TelemetryBatch[] = [];
		const server = createHost({ address: hostKind("server")(), principal: { kind: "server" }, onError() {} });
		await server.load(
			[
				{ name: "scripts", facet: scriptsFacet("web", { set: { base: "initial", combined: "", plugins: [] } }) },
				{
					name: "telemetry",
					facet: telemetryIngestFacet({
						target: {
							ingest(batch) {
								batches.push(batch);
								return batch.spans.length;
							},
						},
						workerHost: () => undefined,
						principalAttributes: () => ({ user: "local" }),
					}),
				},
			],
			context,
		);
		const sockets = new WebSocketServer({ host: "127.0.0.1", port: 0 });
		await once(sockets, "listening");
		const address = sockets.address();
		if (!address || typeof address === "string") throw new Error("Expected TCP listener");
		sockets.on("connection", (socket) =>
			server.accept(webSocketLink(socket), { principal: { kind: "user" } }, context),
		);
		const states: ConnectionState[] = [],
			errors: unknown[] = [],
			render = vi.fn(),
			canRetry = vi.fn(async () => false);
		let themeReads = 0;
		const client = await startPage({
			connect: () => new WebSocket(`ws://127.0.0.1:${address.port}`),
			modules: {},
			telemetry,
			get themes() { themeReads++; return themes; },
			follow,
			render,
			canRetry,
			core: [
				{
					name: "catalog",
					facet: defineFacet((_host, self) =>
						self.contribute(Translations, [
							{
								namespace: "page",
								locale: "en",
								messages: { title: "Local application" },
							},
						]),
					),
				},
			],
			onConnection: (state) => states.push(state),
			onError: (error) => errors.push(error),
		});
		try {
			await vi.waitFor(() => expect(states).toContain("connected"));
			expect(render).toHaveBeenCalledExactlyOnceWith(client.host);
			expect(themeReads).toBe(1);
			expect([element.lang, element.dir, element.style.colorScheme]).toEqual(["en", "ltr", themes === false ? "" : "dark"]);
			expect(removed).toHaveBeenCalledWith("load", watching, true);
			expect(removed).toHaveBeenCalledWith("error", watching, true);
			expect(intervals).toHaveLength(telemetry ? 1 : 0);
			document.visibilityState = "hidden";
			if (telemetry) {
				await client.host.root(async () => {}, context, { trace: { name: "page.started" } });
				await vi.waitFor(() => {
					document.dispatchEvent(new Event("visibilitychange"));
					expect(batches.some((batch) => batch.spans.length > 0)).toBe(true);
				});
			} else {
				document.dispatchEvent(new Event("visibilitychange"));
				expect(batches).toHaveLength(0);
			}
			for (const socket of sockets.clients) socket.close();
			await vi.waitFor(() => expect(follow === false ? canRetry : fetchBase).toHaveBeenCalledOnce());
			if (follow === false) expect(fetchBase).not.toHaveBeenCalled();
			else expect(fetchBase).toHaveBeenCalledWith("/_objects/web/base", { cache: "no-store", credentials: "same-origin" });
			expect(states).toEqual(["connecting", "connected", "waiting"]);
			if (telemetry) {
				expect(reload).toHaveBeenCalledOnce();
				expect(canRetry).not.toHaveBeenCalled();
			} else {
				expect(reload).not.toHaveBeenCalled();
				expect(canRetry).toHaveBeenCalledOnce();
			}
			expect(errors).toEqual([]);
		} finally {
			for (const interval of intervals) clearInterval(interval);
			await client.stop(context);
			await server.close(context);
			for (const socket of sockets.clients) socket.terminate();
			await new Promise<void>((resolve) => sockets.close(() => resolve()));
		}
	},
);
