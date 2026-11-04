import { setFlagsFromString } from "node:v8";
import type { Context } from "../../context/index.ts";
import { isObjectsError, type Principal } from "../../next/data/index.ts";
import type {
	CommittedReload,
	Facet,
	Host,
	LoadReport,
	PluginFacet,
	PluginFailure,
	ReloadReport,
} from "../../next/host/index.ts";
import type { BuiltFacet } from "./build.ts";
import type { Plugin } from "./discover.ts";
import { evaluateFacet, type HostPackages } from "./evaluate.ts";

export type PluginScript = { readonly plugin: Plugin; readonly built: BuiltFacet };
export type RuntimeLoad<P extends Principal> = {
	readonly kind: string;
	readonly core: readonly PluginFacet<P>[];
	readonly scripts: readonly PluginScript[];
	readonly modules: HostPackages;
};
export interface PluginRuntime {
	load<P extends Principal>(host: Host<P>, options: RuntimeLoad<P>, context: Context): Promise<LoadReport>;
	reload<P extends Principal>(host: Host<P>, scripts: readonly PluginScript[], context: Context): Promise<ReloadReport>;
}
type Ready<P extends Principal> = { readonly facet: Facet<P>; readonly digest: string };
let disabledCache = false;
export function createPluginRuntime(): PluginRuntime {
	if (!disabledCache) {
		setFlagsFromString("--no-compilation-cache");
		disabledCache = true;
	}
	return new Runtime();
}
function prepare<P extends Principal>(
	{ plugin, built }: PluginScript,
	modules: HostPackages,
): Ready<P> | { error: unknown } {
	if (built.kind === "failed")
		return {
			error: new Error(
				`plugin "${plugin.name}": its ${built.facet} facet failed to build:\n${built.errors.join("\n")}`,
			),
		};
	try {
		return { facet: evaluateFacet<P>(built, { plugin, hostPackages: modules }), digest: built.digest };
	} catch (error) {
		return { error };
	}
}
function adopt<P extends Principal>(
	previous: Map<string, Ready<P>>,
	next: Map<string, Ready<P>>,
	failed: readonly string[],
): void {
	for (const name of failed) {
		const retained = previous.get(name);
		if (retained) next.set(name, retained);
		else next.delete(name);
	}
	previous.clear();
	for (const [name, value] of next) previous.set(name, value);
}
class Runtime implements PluginRuntime {
	readonly #hosts = new WeakMap<
		object,
		(scripts: readonly PluginScript[], context: Context) => Promise<ReloadReport>
	>();
	async load<P extends Principal>(host: Host<P>, options: RuntimeLoad<P>, context: Context): Promise<LoadReport> {
		const prepared = options.scripts.map(
			(script) => [script.plugin.name, prepare<P>(script, options.modules)] as const,
		);
		const failed: PluginFailure[] = [];
		const facets: PluginFacet<P>[] = [...options.core];
		const loaded = new Map<string, Ready<P>>();
		for (const [name, value] of prepared) {
			if ("error" in value) failed.push({ plugin: name, error: value.error });
			else {
				facets.push({ name, facet: value.facet });
				loaded.set(name, value);
			}
		}
		const report = await host.load(facets, context);
		for (const failure of report.failed) loaded.delete(failure.plugin);
		let tail: Promise<void> = Promise.resolve();
		const { modules, core } = options;
		this.#hosts.set(host, (scripts, current) => {
			const operation = tail.then(async () => {
				const next = new Map<string, Ready<P>>();
				const refused: PluginFailure[] = [];
				for (const script of scripts) {
					const name = script.plugin.name,
						old = loaded.get(name);
					if (script.built.kind === "script" && old?.digest === script.built.digest) {
						next.set(name, old);
						continue;
					}
					const value = prepare<P>(script, modules);
					if ("error" in value) {
						refused.push({ plugin: name, error: value.error });
						if (old) next.set(name, old);
					} else next.set(name, value);
				}
				const all = [...core, ...[...next].map(([name, value]) => ({ name, facet: value.facet }))];
				try {
					const result = await host.reload(all, current, { failed: refused });
					adopt(
						loaded,
						next,
						result.failed.map((item) => item.plugin),
					);
					return result;
				} catch (error) {
					if (isObjectsError(error, "aborted")) {
						const details = error.details as { readonly committed?: CommittedReload } | undefined | null;
						if (details && typeof details === "object" && details.committed)
							adopt(loaded, next, details.committed.failed);
					}
					throw error;
				}
			});
			tail = operation.then(
				() => {},
				() => {},
			);
			return operation;
		});
		return { failed: [...failed, ...report.failed] };
	}
	reload<P extends Principal>(
		host: Host<P>,
		scripts: readonly PluginScript[],
		context: Context,
	): Promise<ReloadReport> {
		const reload = this.#hosts.get(host);
		if (!reload) throw new Error("plugins.reload: the host was not loaded by this runtime");
		return reload(scripts, context);
	}
}
