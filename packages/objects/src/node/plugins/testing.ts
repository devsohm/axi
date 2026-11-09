import { readdir, realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Context } from "../../context/index.ts";
import type { Address } from "../../contracts/index.ts";
import type { Principal } from "../../data/index.ts";
import { createHost, defineFacet, type Ctx, type Host, type HostError, type PluginFacet, type RootOptions } from "../../host/index.ts";
import type { ObjectsHost } from "../../host/internal.ts";
import { defineRegistry, type Registry, type RegistryAccepts, type RegistryTable, type RegistryValue } from "../../registries/index.ts";
import { openNodeSqliteDatabase } from "../../sqlite/node.ts";
import { openStore, sqliteBackend } from "../../store/index.ts";
import { buildFacet, type AppApi } from "./build.ts";
import { discoverPlugins, type Plugin } from "./discover.ts";
import { evaluateFacet, type HostPackages } from "./evaluate.ts";

export type TestPluginOptions<P extends Principal = Principal> = {
	readonly kind: string;
	readonly modules: HostPackages;
	readonly api?: AppApi;
	readonly kinds?: readonly string[];
	readonly platform?: "node" | "browser";
	readonly stubs?: readonly PluginFacet<P>[];
	readonly principal?: P;
	readonly address?: Address;
};
export interface TestedPlugin<P extends Principal = Principal> {
	readonly host: Host<P>;
	readonly plugin: Plugin;
	readonly errors: readonly HostError[];
	contributions<C>(registry: Registry<C, unknown>): RegistryTable<C>;
	unserved(): readonly string[];
	root<T>(fn: (context: Ctx<P>) => Promise<T>, context: Context, options?: RootOptions<P>): Promise<T>;
	close(context: Context): Promise<void>;
}
async function exists(path: string): Promise<boolean> { return stat(path).then(() => true, () => false); }
async function namedKinds(directory: string, found = new Set<string>()): Promise<Set<string>> {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
		if (entry.isDirectory()) await namedKinds(join(directory, entry.name), found);
		if (!entry.isFile()) continue;
		const parts = entry.name.split(".");
		const kind = parts.at(-2)!;
		if (parts.length >= 3 && kind !== "test" && kind !== "spec" && kind !== "d") found.add(kind);
	}
	return found;
}
function checkLoad(report: { readonly failed: readonly { readonly error: unknown }[] }): void {
	if (report.failed.length) throw new Error(`testPlugin: setup failed: ${report.failed.map(({ error }) => error instanceof Error ? error.message : String(error)).join("; ")}`, { cause: report.failed[0].error });
}
export async function testPlugin<P extends Principal = Principal>(directory: string, options: TestPluginOptions<P>, context: Context): Promise<TestedPlugin<P>> {
	const versioned = Object.keys(options.modules).find((name) => /\/v\d+(?:\/|$)/.test(name));
	if (versioned && !options.api) throw new Error(`testPlugin: modules hold the app's versioned API ("${versioned}"): pass api, as production does`);
	const path = await realpath(directory), parent = dirname(path);
	const root = (await stat(path)).isFile() || !(await exists(join(parent, "package.json"))) && !(await exists(join(parent, ".git"))) ? parent : dirname(parent);
	const kinds = options.kinds ?? [options.kind, ...await namedKinds(root)];
	const discovery = await discoverPlugins([root], { kinds }, context);
	const plugin = discovery.plugins.find((item) => item.layout === "directory" ? item.dir === path : Object.values(item.facets).includes(path));
	if (!plugin) {
		const problem = discovery.problems.find((item) => item.path === path);
		throw new Error(`testPlugin: ${path} is no plugin${problem ? `: ${problem.error}` : ""}`);
	}
	const built = await buildFacet(plugin, options.kind, { hostPackages: Object.keys(options.modules), platform: options.platform ?? "node", api: options.api, plugins: discovery.plugins, kinds }, context);
	if (built.kind === "failed") throw new Error(`testPlugin: "${plugin.name}" failed to build:\n${built.errors.join("\n")}`);
	const facet = evaluateFacet<P>(built, { hostPackages: options.modules, plugin });
	const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context);
	const errors: HostError[] = [];
	const host = createHost<P>({ store, principal: options.principal, address: options.address, onError: (error) => errors.push(error) });
	const internal = host as ObjectsHost<P>;
	const facets = [...options.stubs ?? [], { name: plugin.name, facet }];
	const tokens = new Map<string, Registry<unknown, RegistryTable<unknown>>>();
	const collected = new Map<string, RegistryValue<unknown>>();
	try {
		checkLoad(await host.load(facets, context));
		for (;;) {
			const until = Date.now() + internal.timeouts.ready;
			do {
				for (let turn = 0; turn < 3; turn++) await new Promise<void>((resolve) => setImmediate(resolve));
				if (!internal.activationsUnderWay()) break;
				await new Promise<void>((resolve) => setTimeout(resolve, 5));
			} while (Date.now() < until);
			const fresh = internal.undeclaredRegistries().filter(({ name }) => !tokens.has(name));
			if (!fresh.length) break;
			for (const { name, version } of fresh) tokens.set(name, defineRegistry(name, { version }));
			const collector = defineFacet<P>((facet) => {
				for (const token of tokens.values()) {
					const accepts = new Proxy({}, { get: (_target, version) => typeof version === "string" && /^\d+$/.test(version) && Number(version) < token.version ? { contribution: (value: never) => value, value: (value: unknown) => value } : undefined }) as RegistryAccepts<unknown, RegistryTable<unknown>>;
					facet.serve(token, { compose: (entries) => entries, accepts });
				}
			});
			checkLoad(await host.reload([...facets, { name: "objects.test-plugin-collector", facet: collector }], context));
		}
		for (const token of tokens.values()) collected.set(token.name, await host.registry(token, context));
		return {
			host, plugin, errors,
			contributions<C>(registry: Registry<C, unknown>): RegistryTable<C> {
				const value = collected.get(registry.name);
				if (!value) throw new Error(`testPlugin: registry ${registry.name} is not collected (nothing contributed to it unserved at load)`);
				return value.value as RegistryTable<C>;
			},
			unserved: () => internal.unservedNames(),
			root: (fn, current, scope) => host.root(fn, current, scope),
			async close(current) { await host.close(current); await store.close(current); },
		};
	} catch (error) { await host.close(context); await store.close(context); throw error; }
}
