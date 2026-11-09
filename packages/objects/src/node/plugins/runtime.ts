import { setFlagsFromString } from "node:v8";
import type { Context } from "../../context/index.ts";
import type { Principal } from "../../data/index.ts";
import { LoadedFacets, type SetEntry } from "../../surfaces/loaded.ts";
import type { Host, LoadReport, PluginFacet, PluginFailure, ReloadReport } from "../../host/index.ts";
import type { BuiltFacet } from "./build.ts";
import type { Plugin, DiscoveryProblem } from "./discover.ts";
import { evaluateFacet, type HostPackages } from "./evaluate.ts";

export type PluginScript = { readonly plugin: Plugin; readonly built: BuiltFacet };
export class PluginError extends Error {
	readonly required: readonly PluginFailure[];
	readonly failed: readonly PluginFailure[];
	readonly problems: readonly DiscoveryProblem[];
	constructor(
		required: readonly PluginFailure[],
		failed: readonly PluginFailure[],
		problems: readonly DiscoveryProblem[] = [],
	) {
		const reasons = required.map(
			({ plugin, error }) => `"${plugin}": ${error instanceof Error ? error.message : String(error)}`,
		);
		reasons.push(...problems.map(({ path, error }) => `${path}: ${error}`));
		super(`required plugin failed at load: ${reasons.join("; ")}`);
		this.name = "PluginError";
		this.required = required;
		this.failed = failed;
		this.problems = problems;
	}
}
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
let disabledCache = false;
export function createPluginRuntime(): PluginRuntime {
	if (!disabledCache) {
		setFlagsFromString("--no-compilation-cache");
		disabledCache = true;
	}
	return new Runtime();
}
function entries(scripts: readonly PluginScript[], modules: HostPackages): SetEntry[] {
	return scripts.map(({ plugin, built }) => ({
		name: plugin.name,
		digest: built.kind === "script" ? built.digest : undefined,
		prepare() {
			if (built.kind === "failed")
				return {
					kind: "failed",
					error: new Error(
						`plugin "${plugin.name}": its ${built.facet} facet failed to build:\n${built.errors.join("\n")}`,
					),
				};
			try {
				return { kind: "facet", facet: evaluateFacet(built, { plugin, hostPackages: modules }), digest: built.digest };
			} catch (error) {
				return { kind: "failed", error };
			}
		},
	}));
}
class Runtime implements PluginRuntime {
	readonly #hosts = new WeakMap<object, { readonly loaded: LoadedFacets; readonly modules: HostPackages }>();
	async load<P extends Principal>(host: Host<P>, options: RuntimeLoad<P>, context: Context): Promise<LoadReport> {
		const { loaded, report } = await LoadedFacets.load(
			host,
			options.core,
			entries(options.scripts, options.modules),
			context,
		);
		this.#hosts.set(host, { loaded, modules: options.modules });
		const required = new Set(options.scripts.filter(({ plugin }) => plugin.required).map(({ plugin }) => plugin.name));
		const fatal = report.failed.filter(({ plugin }) => required.has(plugin));
		if (fatal.length) throw new PluginError(fatal, report.failed);
		return report;
	}
	reload<P extends Principal>(
		host: Host<P>,
		scripts: readonly PluginScript[],
		context: Context,
	): Promise<ReloadReport> {
		const runtime = this.#hosts.get(host);
		if (!runtime) throw new Error("plugins.reload: the host was not loaded by this runtime");
		return runtime.loaded.reload(host, entries(scripts, runtime.modules), context);
	}
}
