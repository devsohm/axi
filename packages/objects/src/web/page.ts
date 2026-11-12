/// <reference lib="dom" />
import { BACKGROUND_CONTEXT } from "../context/index.ts";
import type { Principal } from "../data/index.ts";
import type { PluginFacet } from "../host/index.ts";
import { webSocketLink, type WebSocketLike } from "../link/index.ts";
import {
	startClient,
	themesFacet,
	translationsFacet,
	WebScripts,
	type Client,
	type ClientError,
	type ClientModules,
	type ConnectionState,
} from "../surfaces/index.ts";
import { sendPageTelemetry, TelemetryRecorder } from "../telemetry-ingest/index.ts";
import { pageEnvironment } from "./environment.ts";
import { followLanguage } from "./language.ts";
import { PageScripts, type PageBootstrap } from "./scripts.ts";
import { PageStyles } from "./styles.ts";
import { followThemes } from "./themes.ts";

export type PageOptions<P extends Principal> = {
	readonly connect: () => WebSocketLike;
	readonly modules: ClientModules;
	readonly core?: readonly PluginFacet<P>[];
	readonly canRetry?: () => Promise<boolean>;
	readonly onConnection?: (state: ConnectionState) => void;
	readonly render: (host: Client<P>["host"]) => void;
	readonly telemetry?: boolean;
	readonly themes?: boolean;
	readonly follow?: boolean;
	readonly onError?: (error: ClientError) => void;
};
const prefix = "/_objects/web/";
export async function startPage<P extends Principal>(options: PageOptions<P>): Promise<Client<P>> {
	const bootstrap = Reflect.get(globalThis, "objectsPage") as PageBootstrap | undefined;
	if (!bootstrap) throw new Error("startPage: the page has no Objects bootstrap (PageAssets.bootstrap)");
	const scripts = new PageScripts(bootstrap),
		onError = options.onError ?? ((error: ClientError) => console.error("objects page:", error));
	document.removeEventListener("load", bootstrap.watching, true);
	document.removeEventListener("error", bootstrap.watching, true);
	const themes = options.themes !== false;
	let recorder: TelemetryRecorder | undefined;
	const client = await startClient<P>({
		scripts: WebScripts,
		base: scripts.base,
		initial: scripts.initial,
		modules: options.modules,
		core: [
			...(themes ? [{ name: "objects.themes", facet: themesFacet<P>() }] : []),
			{ name: "objects.translations", facet: translationsFacet<P>() },
			...(options.core ?? []),
		],
		open(events) {
			const socket = options.connect();
			socket.addEventListener("open", events.opened);
			socket.addEventListener("message", events.received);
			return webSocketLink(socket);
		},
		fetchScript: (entry) => scripts.fetch(entry),
		async serverBase() {
			try {
				const response = await fetch(`${prefix}base`, { cache: "no-store", credentials: "same-origin" });
				return response.ok ? ((await response.json()) as string) : undefined;
			} catch {
				return undefined;
			}
		},
		outdated: () => location.reload(),
		canRetry: options.canRetry,
		follow: options.follow,
		onConnection: options.onConnection,
		styles: new PageStyles(bootstrap.styles, bootstrap.links, onError),
		environment: pageEnvironment(),
		onError,
		telemetry: options.telemetry
			? (incarnation) => (recorder = new TelemetryRecorder(() => `browser:${incarnation()}`, 1000))
			: undefined,
	});
	if (recorder) {
		const sender = sendPageTelemetry(client.host, recorder, BACKGROUND_CONTEXT);
		setInterval(() => void sender.send(false), 3000);
		document.addEventListener("visibilitychange", () => {
			if (document.visibilityState === "hidden") void sender.send(true);
		});
	}
	if (themes) await followThemes(client.host, BACKGROUND_CONTEXT);
	await followLanguage(client.host, (report) => onError({ kind: "messages", report }), BACKGROUND_CONTEXT);
	options.render(client.host);
	return client;
}
