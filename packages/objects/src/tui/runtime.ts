import { BACKGROUND_CONTEXT } from "../context/index.ts";
import type { Principal } from "../data/index.ts";
import type { PluginFacet } from "../host/index.ts";
import {
	FALLBACK_THEMES,
	followActiveLanguage,
	followActiveTheme,
	REGISTER,
	startClient,
	themesFacet,
	translationsFacet,
	TuiScripts,
	type Client,
	type ClientError,
	type ClientModules,
	type ConnectionState,
	type FacetFunction,
	type RegisteredScript,
} from "../surfaces/index.ts";
import { BRIDGE, type Bridge } from "./bridge.ts";
import { SandboxChannel } from "./channel.ts";
import { BridgeTerminal } from "./terminal.ts";
import { TerminalTheme } from "./theme.ts";
export type AttachedFile = { readonly name: string; readonly bytes: Uint8Array };
export type TerminalRuntimeOptions<P extends Principal> = {
	readonly modules: ClientModules;
	readonly core?: readonly PluginFacet<P>[];
	readonly canRetry?: () => Promise<boolean>;
	readonly onConnection?: (state: ConnectionState) => void;
	readonly render: (runtime: TerminalRuntime<P>) => void;
	readonly onError?: (error: ClientError) => void;
};
export type TerminalRuntime<P extends Principal> = {
	readonly host: Client<P>["host"];
	readonly terminal: BridgeTerminal;
	readonly theme: TerminalTheme;
	copy(text: string): Promise<boolean>;
	open(url: string): Promise<boolean>;
	attach(path: string): Promise<AttachedFile | undefined>;
	exit(code: number): void;
};
export async function startTerminalRuntime<P extends Principal>(
	options: TerminalRuntimeOptions<P>,
): Promise<TerminalRuntime<P>> {
	const bridge = Reflect.get(globalThis, BRIDGE) as Bridge | undefined;
	if (!bridge) throw new Error("startTerminalRuntime: not inside the terminal's sandbox (no bridge)");
	Reflect.deleteProperty(globalThis, BRIDGE);
	const channel = new SandboxChannel(bridge),
		{ start } = channel;
	let registered: RegisteredScript[] = [];
	Reflect.set(globalThis, REGISTER, (plugin: string, digest: string, run: FacetFunction) =>
		registered.push({ plugin, digest, run }),
	);
	const evaluate = (text: string): RegisteredScript[] => {
		registered = [];
		channel.evaluate(text, "objects-plugins.js");
		return registered;
	};
	const onError = options.onError ?? (() => {});
	const client = await startClient<P>({
		scripts: TuiScripts,
		base: start.base,
		initial: evaluate(start.combined),
		modules: options.modules,
		core: [
			{ name: "objects.themes", facet: themesFacet<P>() },
			{ name: "objects.translations", facet: translationsFacet<P>() },
			...(options.core ?? []),
		],
		open: (events) => channel.openSocket(events),
		async fetchScript(entry) {
			const text = (await channel.request({ kind: "fetch", path: entry.url })) as string;
			const found = evaluate(text).find((script) => script.plugin === entry.name && script.digest === entry.digest);
			if (!found) throw new Error(`plugin "${entry.name}": ${entry.url} did not register`);
			return found;
		},
		serverBase: () =>
			channel.request({ kind: "base" }).then(
				(base) => base as string,
				() => undefined,
			),
		outdated: () => channel.outdated(),
		canRetry: options.canRetry,
		onConnection: options.onConnection,
		onError,
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
	const theme = new TerminalTheme(FALLBACK_THEMES[start.mode], start.colors);
	await followActiveTheme(client.host, start.mode, (value) => theme.set(value), BACKGROUND_CONTEXT);
	await followActiveLanguage(
		client.host,
		start.locales,
		() => {},
		(report) => onError({ kind: "messages", report }),
		BACKGROUND_CONTEXT,
	);
	const runtime: TerminalRuntime<P> = {
		host: client.host,
		terminal: new BridgeTerminal(channel),
		theme,
		copy: (text) => channel.request({ kind: "copy", text }).then(Boolean),
		open: (url) => channel.request({ kind: "open", url }).then(Boolean),
		attach: (path) =>
			channel.request({ kind: "attach", path }).then((file) => (file === null ? undefined : (file as AttachedFile))),
		exit: (code) => channel.exit(code),
	};
	options.render(runtime);
	return runtime;
}
