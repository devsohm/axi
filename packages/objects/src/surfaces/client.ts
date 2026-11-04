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
	readonly applied?: (set: ScriptSet) => void;
	readonly environment: LoopEnvironment;
	readonly telemetry?: (incarnation: () => string) => TelemetryContext;
	readonly onError: (error: ClientError) => void;
};
export type Client<P extends Principal> = { readonly host: Host<P>; stop(context: Context): Promise<void> };

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
	const loop = keepConnected({
		environment: options.environment,
		onState: (state) => options.onConnection?.(state),
		open(events) {
			const link = shareClose(options.open(events));
			host.connect(link, { principal: { kind: "server" } as P }, context);
			return link;
		},
		async canRetry() {
			const latest = await options.serverBase();
			if (latest !== undefined && latest !== options.base) {
				options.outdated();
				return false;
			}
			return (await options.canRetry?.()) ?? true;
		},
	});
	let scripts = new Map(options.initial.map((script) => [script.plugin, script]));
	const abort = new AbortController(),
		held = host.hold(options.scripts, {}, context);
	async function apply(set: ScriptSet, ctx: Context): Promise<void> {
		if (set.base !== options.base) {
			options.outdated();
			return;
		}
		if (
			set.plugins.length === scripts.size &&
			set.plugins.every((item) => scripts.get(item.name)?.digest === item.digest)
		) {
			options.applied?.(set);
			return;
		}
		try {
			const next = new Map<string, RegisteredScript>();
			for (const item of set.plugins) {
				const previous = scripts.get(item.name);
				next.set(item.name, previous?.digest === item.digest ? previous : await options.fetchScript(item));
			}
			const result = await loaded.reload(
				host,
				Array.from(next.values(), (script) => entry(script, options.modules)),
				ctx,
			);
			scripts = next;
			reportPlugins(result.failed);
			options.applied?.(set);
		} catch (error) {
			options.onError({ kind: "update_failed", error });
		}
	}
	const watch = await held.set.watch(withAbortSignal(abort.signal, context));
	watch.start(async (frame, ctx) => {
		if (frame.kind === "value") await apply(frame.value, ctx);
	});
	return {
		host,
		async stop(ctx) {
			loop.stop();
			abort.abort();
			held.release();
			await host.close(ctx);
		},
	};
}
