import { afterEach, expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import {
	createHost,
	defineFacet,
	hostKind,
	memoryLinkPair,
	Translations,
	type Link,
	type Principal,
} from "../src/index.ts";
import { publishTo, scriptsFacet } from "../src/node/surfaces/current.ts";
import { REGISTER } from "../src/surfaces/registered.ts";
import type { ScriptSet } from "../src/surfaces/scripts.ts";
import { BRIDGE, type Bridge, type LauncherMessage, type SandboxMessage } from "../src/tui/bridge.ts";
import { startTerminalRuntime } from "../src/tui/runtime.ts";

afterEach(() => {
	vi.unstubAllGlobals();
	Reflect.deleteProperty(globalThis, REGISTER);
});

test("the terminal runtime loads and replaces plugins over its bridge and routes user actions", async () => {
	const server = createHost<Principal>({ address: hostKind("server")(), principal: { kind: "server" }, onError() {} });
	const scriptSet = (digest: string): ScriptSet => ({
		base: "base",
		combined: "/all.js",
		plugins: [{ name: "screen", digest, url: `/${digest}.js` }],
	});
	await server.load([{ name: "scripts", facet: scriptsFacet("tui", { set: scriptSet("one") }) }], context);
	const sockets = new Map<number, Link>(),
		sent: SandboxMessage[] = [];
	let receive = (_message: LauncherMessage): void => {};
	const bridge: Bridge = {
		start: { base: "base", combined: "one", columns: 80, rows: 24, colors: "truecolor", mode: "dark", locales: ["en"] },
		onMessage(listener) {
			receive = listener;
		},
		evaluate(source) {
			const register = Reflect.get(globalThis, REGISTER);
			if (typeof register !== "function") throw new Error("Missing plugin registration");
			register("screen", source, (_require: unknown, module: { exports: unknown }) => {
				module.exports = {
					default: defineFacet((_host, self) =>
						self.contribute(Translations, [{ namespace: "screen", locale: "en", messages: { title: source } }]),
					),
				};
			});
		},
		send(message) {
			sent.push(message);
			if (message.kind === "socket_open") {
				const [local, remote] = memoryLinkPair();
				sockets.set(message.socket, local);
				local.onMessage((bytes) => receive({ kind: "socket_message", socket: message.socket, bytes }));
				local.onClose(() => receive({ kind: "socket_closed", socket: message.socket }));
				server.accept(remote, { principal: { kind: "user", id: "reader" } }, context);
				queueMicrotask(() => receive({ kind: "socket_opened", socket: message.socket }));
			} else if (message.kind === "socket_send") sockets.get(message.socket)?.send(message.bytes);
			else if (message.kind === "socket_close") sockets.get(message.socket)?.close();
			else if (message.kind === "request") {
				const request = message.request;
				let value: unknown;
				if (request.kind === "fetch") value = request.path.slice(1, -3);
				else if (request.kind === "base") value = "base";
				else if (request.kind === "attach")
					value = request.path === "exists" ? { name: "file.txt", bytes: new Uint8Array([1, 2]) } : null;
				else value = true;
				queueMicrotask(() => receive({ kind: "reply", id: message.id, value }));
			}
		},
	};
	vi.stubGlobal(BRIDGE, bridge);
	const rendered = vi.fn(),
		connections: string[] = [];
	const runtime = await startTerminalRuntime({
		modules: {},
		canRetry: async () => false,
		onConnection: (state) => connections.push(state),
		render: rendered,
	});
	try {
		expect(Reflect.has(globalThis, BRIDGE)).toBe(false);
		expect(rendered).toHaveBeenCalledWith(runtime);
		expect([runtime.terminal.columns, runtime.terminal.rows]).toEqual([80, 24]);
		const translations = await runtime.host.registry(Translations, context);
		expect(translations.value.catalogs.get("screen")?.get("en")?.value.messages.title).toBe("one");
		await publishTo(server, "tui", scriptSet("two"), context);
		await vi.waitFor(() =>
			expect(translations.value.catalogs.get("screen")?.get("en")?.value.messages.title).toBe("two"),
		);
		expect(await runtime.copy("selected text")).toBe(true);
		expect(await runtime.open("https://example.test")).toBe(true);
		expect(await runtime.attach("exists")).toEqual({ name: "file.txt", bytes: new Uint8Array([1, 2]) });
		expect(await runtime.attach("absent")).toBeUndefined();
		runtime.exit(7);
		expect(sent).toContainEqual({ kind: "exit", code: 7 });
		expect(connections).toContain("connected");
	} finally {
		await runtime.host.close(context);
		for (const link of sockets.values()) link.close();
		await server.close(context);
		await vi.waitFor(() => expect(connections.at(-1)).toBe("waiting"));
	}
});

test("terminal runtime startup without its launcher bridge fails before rendering", async () => {
	Reflect.deleteProperty(globalThis, BRIDGE);
	const render = vi.fn();
	await expect(startTerminalRuntime({ modules: {}, render })).rejects.toThrow(/no bridge/);
	expect(render).not.toHaveBeenCalled();
});
