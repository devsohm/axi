import type { TelemetryContext } from "@axi/telemetry";
import { BACKGROUND_CONTEXT, withAbortSignal, type Context } from "../context/index.ts";
import type { Principal } from "../data/index.ts";
import { createHost, type Host, type HostError, type PluginFacet, type PluginFailure } from "../host/index.ts";
import type { Link } from "../link/index.ts";
import { keepConnected, type ConnectionState, type LoopEnvironment, type SocketEvents } from "./connection.ts";
import type { MessagesReport } from "./language.ts";
import { LoadedFacets, type SetEntry } from "./loaded.ts";
import { evaluateRegistered, type ClientModules, type RegisteredScript } from "./registered.ts";
import type { ScriptEntry, ScriptSet, ScriptsContract } from "./scripts.ts";

export type ClientError =
	| { readonly kind: "host"; readonly error: HostError }
	| { readonly kind: "plugins"; readonly failed: readonly PluginFailure[] }
	| { readonly kind: "update_failed"; readonly error: unknown }
	| { readonly kind: "stylesheet_failed"; readonly plugin: string; readonly url: string; readonly reason: "error" | "timeout" }
	| { readonly kind: "messages"; readonly report: MessagesReport };
export type ClientOptions<P extends Principal> = {
	readonly scripts: ScriptsContract;
	readonly base: string;
	readonly initial: readonly RegisteredScript[];
	readonly modules: ClientModules;
	readonly core: readonly PluginFacet<P>[];
	readonly open: (events: SocketEvents) => Link;
	readonly fetchScript: (entry: ScriptEntry) => Promise<RegisteredScript>;
	readonly serverBase: () => Promise<string | undefined>;
	readonly outdated: () => void;
	readonly canRetry?: () => Promise<boolean>;
	readonly onConnection?: (state: ConnectionState) => void;
	readonly styles?: ClientStyles;
	readonly environment: LoopEnvironment;
	readonly telemetry?: (incarnation: () => string) => TelemetryContext;
	readonly follow?: boolean;
	readonly onError: (error: ClientError) => void;
};
export type Client<P extends Principal> = { readonly host: Host<P>; stop(context: Context): Promise<void> };
export type ClientStyles = {
	prepare(set: ScriptSet, signal: AbortSignal): Promise<void>;
	settle(set: ScriptSet, kept: ReadonlySet<string>): void;
};

function shareClose(link: Link): Link {
	let closed = false;
	const listeners = new Set<() => void>();
	link.onClose(() => {
		closed = true;
		for (const listener of listeners) listener();
		listeners.clear();
	});
	return {
		send: (message) => link.send(message),
		close: () => link.close(),
		onMessage: (listener) => link.onMessage(listener),
		onClose(listener) {
			if (closed) listener();
			else listeners.add(listener);
		},
	};
}
function entry(script: RegisteredScript, modules: ClientModules): SetEntry {
	return {
		name: script.plugin,
		digest: script.digest,
		prepare() {
			try {
				return { kind: "facet", facet: evaluateRegistered(script, modules), digest: script.digest };
			} catch (error) {
				return { kind: "failed", error };
			}
		},
	};
}
export async function startClient<P extends Principal>(options: ClientOptions<P>): Promise<Client<P>> {
	const context = BACKGROUND_CONTEXT;
	const telemetry: TelemetryContext | undefined = options.telemetry?.(() => host.incarnation);
	const host: Host<P> = createHost<P>({ telemetry, onError: (error) => options.onError({ kind: "host", error }) });
	const { loaded, report } = await LoadedFacets.load(
		host,
		options.core,
		options.initial.map((script) => entry(script, options.modules)),
		context,
	);
	const reportPlugins = (failed: readonly PluginFailure[]): void => {
		if (failed.length) options.onError({ kind: "plugins", failed });
	};
	reportPlugins(report.failed);
	const left = new Set(report.failed.map(({ plugin }) => plugin));
	let scripts = new Map(options.initial.filter(script => !left.has(script.plugin)).map(script => [script.plugin, script]));
	const abort = new AbortController();
	const following = options.follow !== false;
	const serverBase = following ? options.serverBase : undefined;
	let latest: ScriptSet | undefined, cancelRetry: (() => void) | undefined;
	let applying = Promise.resolve(), pause = 0;
	const runs = (set: ScriptSet) => set.plugins.length === scripts.size && set.plugins.every(item => scripts.get(item.name)?.digest === item.digest);
	const loop = keepConnected({
		environment: options.environment,
		onState: (state) => {
			options.onConnection?.(state);
			if (following && state === "connected" && latest !== undefined && !runs(latest)) void queue(latest, context);
		},
		open(events) {
			const link = shareClose(options.open(events));
			host.connect(link, { principal: { kind: "server" } as P }, context);
			return link;
		},
		async canRetry() {
			const latest = await serverBase?.();
			if (latest !== undefined && latest !== options.base) {
				loop.stop();
				options.outdated();
				return false;
			}
			return (await options.canRetry?.()) ?? true;
		},
	});
	const held = following ? host.hold(options.scripts, {}, context) : undefined;
	function queue(set: ScriptSet, ctx: Context): Promise<void> {
		applying = applying.then(async () => {
			if (set !== latest || abort.signal.aborted) return;
			if (await apply(set, ctx)) return;
			pause = pause ? Math.min(pause * 2, 30000) : 1000;
			cancelRetry = options.environment.after(pause, () => {
				cancelRetry = undefined;
				void queue(set, ctx);
			});
		});
		return applying;
	}
	async function apply(set: ScriptSet, ctx: Context): Promise<boolean> {
		if (set.base !== options.base) {
			options.outdated();
			return true;
		}
		try {
			const next = new Map<string, RegisteredScript>(), changed = !runs(set);
			if (changed) for (const item of set.plugins) {
				const previous = scripts.get(item.name);
				next.set(item.name, previous?.digest === item.digest ? previous : await options.fetchScript(item));
			}
			await options.styles?.prepare(set, abort.signal);
			if (abort.signal.aborted) return true;
			const kept = new Set<string>();
			if (changed) {
				const result = await loaded.reload(host, Array.from(next.values(), script => entry(script, options.modules)), ctx);
				for (const { plugin } of result.failed) {
					kept.add(plugin);
					const old = scripts.get(plugin);
					if (old !== undefined) next.set(plugin, old); else next.delete(plugin);
				}
				scripts = next;
				reportPlugins(result.failed);
			}
			options.styles?.settle(set, kept);
			return true;
		} catch (error) {
			options.onError({ kind: "update_failed", error });
			return false;
		}
	}
	function take(set: ScriptSet, ctx: Context): Promise<void> {
		latest = set;
		cancelRetry?.();
		cancelRetry = undefined;
		pause = 0;
		return queue(set, ctx);
	}
	async function follow(): Promise<void> {
		if (held === undefined) return;
		const watch = await held.set.watch(withAbortSignal(abort.signal, context));
		void take(watch.value, context);
		watch.start(async (frame, ctx) => {
			if (frame.kind === "value") await take(frame.value, ctx);
		});
	}
	// Bundled plugins can start before the server admits the script watch.
	if (following) void follow().catch((error) => options.onError({ kind: "update_failed", error }));
	return {
		host,
		async stop(ctx) {
			loop.stop();
			abort.abort();
			cancelRetry?.();
			cancelRetry = undefined;
			held?.release();
			await host.close(ctx);
		},
	};
}
