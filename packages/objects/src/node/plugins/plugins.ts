import type { Context } from "../../context/index.ts";
import type { Principal } from "../../data/index.ts";
import type { Host, LoadReport, PluginFacet, ReloadReport } from "../../host/index.ts";
import { Batch, type BatchError } from "../../state/internal.ts";
import type { Watchable } from "../../watch.ts";
import { type AppApi, type BuiltFacet, buildFacet } from "./build.ts";
import { type Discovery, discoverPlugins, sameFiles, type Plugin, type PluginRoot } from "./discover.ts";
import type { HostPackages } from "./evaluate.ts";
import { type InstallOptions, type PluginSource, installDependencies, installPlugin } from "./install.ts";
import { createPluginRuntime, PluginError, type PluginScript } from "./runtime.ts";
import { type MarkSnapshot, type PluginsState, PluginWatcher } from "./watcher.ts";

export type PluginsOptions = {
	readonly roots: readonly PluginRoot[];
	readonly kinds: Readonly<Record<string, KindDefinition>>;
	readonly base?: readonly string[];
	readonly publicPath?: string;
	readonly install?: InstallOptions;
	readonly api?: AppApi;
	readonly onError: (error: PluginsError) => void;
};
export type KindDefinition = { readonly platform: "node" | "browser"; readonly hostPackages: readonly string[] };
export type PluginsError = BatchError | { readonly kind: "watch_failed"; readonly error: unknown };
export type Built = {
	readonly facets: readonly BuiltFacet[];
	readonly plugins: Readonly<Record<string, Plugin>>;
	readonly removed: readonly string[];
};
export type RolloutHost =
	| { readonly host: string; readonly report: ReloadReport }
	| { readonly host: string; readonly stopped: true }
	| { readonly host: string; readonly error: unknown };
export type RolloutStep = {
	readonly name: string;
	readonly kinds: readonly string[];
	reload(built: Built, context: Context): Promise<{ readonly hosts: readonly RolloutHost[] }>;
};
export type RolloutResult = {
	readonly steps: readonly { readonly name: string; readonly hosts: readonly RolloutHost[] }[];
	readonly stopped: { readonly step: string; readonly error: unknown } | undefined;
};
export interface Plugins {
	readonly state: Watchable<PluginsState>;
	readonly discovery: Discovery;
	build(names: readonly string[], context: Context): Promise<Built>;
	scripts(kind: string, context: Context): Promise<readonly PluginScript[]>;
	current(kind: string): readonly PluginScript[] | undefined;
	load<P extends Principal>(
		host: Host<P>,
		options: { readonly kind: string; readonly core: readonly PluginFacet<P>[]; readonly modules: HostPackages },
		context: Context,
	): Promise<LoadReport>;
	reload<P extends Principal>(host: Host<P>, built: Built, context: Context): Promise<ReloadReport>;
	step<P extends Principal>(name: string, host: Host<P>): RolloutStep;
	rollout(steps: readonly RolloutStep[], built: Built, context: Context): Promise<RolloutResult>;
	watchBase(files: readonly string[]): void;
	installDependencies(name: string, context: Context): Promise<void>;
	installPlugin(source: PluginSource, root: string, context: Context): Promise<readonly string[]>;
	close(): void;
}
export function createPlugins(options: PluginsOptions, _context: Context): Plugins {
	return new PluginComponent(options);
}
class PluginComponent implements Plugins {
	readonly #options: PluginsOptions;
	readonly #watcher: PluginWatcher;
	readonly #cache = new Map<string, BuiltFacet>();
	readonly #hosts = new WeakMap<object, string>();
	readonly #runtime = createPluginRuntime();
	readonly #sets = new Map<string, Map<string, PluginScript>>();
	readonly #snapshots = new WeakMap<Built, MarkSnapshot>();
	#known: Discovery = { plugins: [], problems: [] };
	#discovered = false;
	constructor(options: PluginsOptions) {
		this.#options = options;
		this.#watcher = new PluginWatcher(
			{
				roots: options.roots.map((root) => (typeof root === "string" ? root : root.path)),
				base: options.base ?? [],
				kinds: Object.keys(options.kinds),
				failed: (error) => options.onError({ kind: "watch_failed", error }),
			},
			new Batch((error) => options.onError(error), undefined),
		);
	}
	get state(): Watchable<PluginsState> {
		return this.#watcher as unknown as Watchable<PluginsState>;
	}
	get discovery(): Discovery {
		return this.#known;
	}
	async #discover(context: Context): Promise<void> {
		const seen = this.#watcher.discoverySnapshot();
		this.#known = await discoverPlugins(this.#options.roots, { kinds: Object.keys(this.#options.kinds) }, context);
		this.#discovered = true;
		this.#watcher.know(this.#known, seen);
	}
	async #compile(plugin: Plugin, kind: string, context: Context): Promise<BuiltFacet> {
		const { publicPath } = this.#options;
		const { hostPackages, platform } = this.#options.kinds[kind]!;
		const output = await buildFacet(
			plugin,
			kind,
			{
				hostPackages,
				platform,
				kinds: Object.keys(this.#options.kinds),
				...(this.#options.api ? { api: this.#options.api } : {}),
				plugins: this.#known.plugins,
				...(publicPath === undefined ? {} : { publicPath }),
			},
			context,
		);
		this.#cache.set(`${plugin.name}\0${kind}`, output);
		this.#watcher.used([output]);
		return output;
	}
	async build(names: readonly string[], context: Context): Promise<Built> {
		const previous = new Map(this.#known.plugins.map((plugin) => [plugin.name, plugin]));
		if (!this.#discovered || this.#watcher.needsDiscovery) await this.#discover(context);
		const present = new Set(this.#known.plugins.map(({ name }) => name));
		const removed = [...previous.keys()].filter((name) => !present.has(name));
		const selected = this.#known.plugins.filter(
			(plugin) =>
				names.includes(plugin.name) || !previous.has(plugin.name) || !sameFiles(previous.get(plugin.name)!, plugin),
		);
		const seen = this.#watcher.snapshot([...selected.map(({ name }) => name), ...removed]);
		const facets = await Promise.all(
			selected.flatMap((plugin) => Object.keys(plugin.facets).map((kind) => this.#compile(plugin, kind, context))),
		);
		const built: Built = {
			facets,
			plugins: Object.fromEntries(selected.map((plugin) => [plugin.name, plugin])),
			removed,
		};
		this.#snapshots.set(built, seen);
		return built;
	}
	async #set(kind: string, context: Context): Promise<Map<string, PluginScript>> {
		const existing = this.#sets.get(kind);
		if (existing) return existing;
		if (!this.#discovered) await this.#discover(context);
		const scripts = await Promise.all(
			this.#known.plugins
				.filter((plugin) => plugin.facets[kind] !== undefined)
				.map(async (plugin) => ({
					plugin,
					built: this.#cache.get(`${plugin.name}\0${kind}`) ?? (await this.#compile(plugin, kind, context)),
				})),
		);
		const result = this.#sets.get(kind) ?? new Map(scripts.map((script) => [script.plugin.name, script]));
		this.#sets.set(kind, result);
		return result;
	}
	async scripts(kind: string, context: Context): Promise<readonly PluginScript[]> {
		return [...(await this.#set(kind, context)).values()];
	}
	current(kind: string): readonly PluginScript[] | undefined {
		const set = this.#sets.get(kind);
		return set && [...set.values()];
	}
	async load<P extends Principal>(
		host: Host<P>,
		options: { readonly kind: string; readonly core: readonly PluginFacet<P>[]; readonly modules: HostPackages },
		context: Context,
	): Promise<LoadReport> {
		const { kind, core, modules } = options;
		const scripts = await this.scripts(kind, context);
		this.#hosts.set(host, kind);
		const problems = this.#known.problems.filter((problem) => problem.required);
		let report: LoadReport;
		try {
			report = await this.#runtime.load(host, { kind, core, modules, scripts }, context);
		} catch (error) {
			if (error instanceof PluginError && problems.length)
				throw new PluginError(error.required, error.failed, problems);
			throw error;
		}
		if (problems.length) throw new PluginError([], report.failed, problems);
		return report;
	}
	async reload<P extends Principal>(host: Host<P>, built: Built, context: Context): Promise<ReloadReport> {
		const kind = this.#hosts.get(host);
		if (kind === undefined) throw new Error("plugins.reload: the host was not loaded by this component");
		const scripts = await this.#set(kind, context);
		ship(scripts, kind, built);
		return this.#runtime.reload(host, [...scripts.values()], context);
	}
	step<P extends Principal>(name: string, host: Host<P>): RolloutStep {
		const kind = this.#hosts.get(host);
		if (kind === undefined) throw new Error("plugins.step: the host was not loaded by this component");
		return {
			name,
			kinds: [kind],
			reload: async (built, context) => ({ hosts: [{ host: name, report: await this.reload(host, built, context) }] }),
		};
	}
	async rollout(steps: readonly RolloutStep[], built: Built, context: Context): Promise<RolloutResult> {
		const completed: { readonly name: string; readonly hosts: readonly RolloutHost[] }[] = [];
		const failures = new Set<string>(),
			shipped = new Set<string>();
		for (const step of steps) {
			let hosts: readonly RolloutHost[];
			try {
				for (const kind of step.kinds) ship(await this.#set(kind, context), kind, built);
				hosts = (await step.reload(built, context)).hosts;
			} catch (error) {
				return { steps: completed, stopped: { step: step.name, error } };
			}
			for (const kind of step.kinds) shipped.add(kind);
			for (const entry of hosts) {
				if ("report" in entry) for (const item of entry.report.failed) failures.add(item.plugin);
				else if ("error" in entry)
					for (const facet of built.facets) if (step.kinds.includes(facet.facet)) failures.add(facet.plugin);
			}
			completed.push({ name: step.name, hosts });
		}
		for (const facet of built.facets) if (!shipped.has(facet.facet)) failures.add(facet.plugin);
		const snapshot = this.#snapshots.get(built);
		if (snapshot)
			this.#watcher.applied(
				[...snapshot.plugins.keys()].filter((name) => !failures.has(name)),
				snapshot,
			);
		return { steps: completed, stopped: undefined };
	}

	watchBase(files: readonly string[]): void {
		this.#watcher.baseFiles(files);
	}

	async installDependencies(name: string, context: Context): Promise<void> {
		if (!this.#discovered) await this.#discover(context);
		const plugin = this.#known.plugins.find((item) => item.name === name);
		if (!plugin) throw new Error(`plugins.installDependencies: no plugin "${name}"`);
		await installDependencies(plugin, context, this.#options.install);
		this.#watcher.installed(name);
	}
	async installPlugin(source: PluginSource, root: string, context: Context): Promise<readonly string[]> {
		if (!this.#options.roots.some((item) => (typeof item === "string" ? item : item.path) === root))
			throw new Error(`plugins.installPlugin: ${root} is not one of the roots`);
		const installed = await installPlugin(source, root, context, {
			...this.#options.install,
			kinds: Object.keys(this.#options.kinds),
			roots: this.#options.roots,
		});
		this.#watcher.added();
		return installed;
	}
	close(): void {
		this.#watcher.close();
	}
}

function ship(scripts: Map<string, PluginScript>, kind: string, built: Built): void {
	for (const name of built.removed) scripts.delete(name);
	for (const [name, plugin] of Object.entries(built.plugins))
		if (plugin.facets[kind] === undefined) scripts.delete(name);
	for (const facet of built.facets)
		if (facet.facet === kind && Object.hasOwn(built.plugins, facet.plugin)) {
			scripts.set(facet.plugin, { plugin: built.plugins[facet.plugin]!, built: facet });
		}
}
