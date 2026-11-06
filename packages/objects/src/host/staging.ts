import type { Context } from "../context/index.ts";
import type { Watchable } from "../watch.ts";
import type { Contract, ParamsOf } from "../contracts/index.ts";
import { contractData } from "../contracts/internal.ts";
import type { Principal } from "../data/index.ts";
import { bindProvider, checkParams } from "../data/internal.ts";
import type { AnyDefinition } from "../documents/internal.ts";
import type { JobDefinition } from "../jobs/index.ts";
import type { Registry, RegistryProvider } from "../registries/index.ts";
import { checkRegistryProvider } from "../registries/record.ts";
import { tableSqlName } from "../store/sql.ts";
import { checkLiveQuery } from "../store/live-query.ts";
import type { Query } from "../store/query.ts";
import type { TableDefinition } from "../store/table.ts";
import type { StoreSelf } from "./attempt.ts";
import { setUp, type Facet, type FacetContribution } from "./facet.ts";
import type { ObjectsObject, Served } from "./object.ts";
import type { Presence } from "./presence.ts";
import { retrySource } from "./retry-on.ts";

export type PluginFacet<P extends Principal = Principal> = { readonly name: string; readonly facet: Facet<P> };
export type PluginDeclarations<P extends Principal> = {
	readonly name: string;
	readonly facet: Facet<P>;
	readonly types: ReadonlyMap<string, Served>;
	readonly registries: ReadonlyMap<string, StagedRegistry>;
	readonly contributions: readonly FacetContribution[];
};
export type StagedRegistry = {
	readonly plugin: string;
	readonly token: Registry<unknown, unknown>;
	readonly provider: RegistryProvider<unknown, unknown>;
};
export type Staged<P extends Principal> = {
	readonly plugins: Map<string, PluginDeclarations<P>>;
	readonly types: Map<string, Served>;
	readonly registries: Map<string, StagedRegistry>;
};
type SetupHost<P extends Principal> = {
	readonly principal: P | undefined;
	readonly address: unknown;
	references<C extends Contract>(type: C): Watchable<readonly Presence<C, P>[]>;
};
const validName = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/;
export const isPluginName = (name: string): boolean => validName.test(name);
function located(error: unknown, label: string): Error {
	return new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
}

export function emptyStaged<P extends Principal>(): Staged<P> {
	return { plugins: new Map(), types: new Map(), registries: new Map() };
}

export function addStaged<P extends Principal>(staged: Staged<P>, plugin: PluginDeclarations<P>): Error | undefined {
	for (const [kind, entries, existing] of [
		["", plugin.types, staged.types],
		["registry ", plugin.registries, staged.registries],
	] as const) {
		for (const name of entries.keys()) {
			const owner = existing.get(name)?.plugin;
			if (owner !== undefined)
				return new Error(`plugin "${plugin.name}": ${kind}${name} is served twice (plugin "${owner}")`);
		}
	}
	for (const [name, value] of plugin.types) staged.types.set(name, value);
	for (const [name, value] of plugin.registries) staged.registries.set(name, value);
	staged.plugins.set(plugin.name, plugin);
	return undefined;
}

export function stagePlugin<P extends Principal>(
	{ name, facet }: PluginFacet<P>,
	host: SetupHost<P>,
): PluginDeclarations<P> {
	if (!isPluginName(name)) throw new Error(`"${name}" is not a valid plugin name`);
	const types = new Map<string, Served>();
	const registries = new Map<string, StagedRegistry>();
	try {
		const declarations = setUp(name, facet, (type) => host.references(type));
		for (const entry of declarations.served) {
			if (entry.kind === "registry") {
				if (registries.has(entry.registry.name)) throw new Error(`registry ${entry.registry.name} is served twice`);
				checkRegistryProvider(entry.registry.name, entry.provider);
				registries.set(entry.registry.name, { plugin: name, token: entry.registry, provider: entry.provider });
				continue;
			}
			const { contract, factory, options } = entry;
			if (types.has(contract.name)) throw new Error(`${contract.name} is served twice`);
			if (contract.kind === "remote") {
				if (host.principal === undefined)
					throw new Error(`${contract.name}: a host without a principal serves only local types`);
				if (host.address === undefined)
					throw new Error(`${contract.name}: a host without an address serves only local types`);
			}
			const common = {
				plugin: name,
				contract,
				provider: bindProvider(contract, options.accepts ?? {}),
				linger: options.linger ?? 0,
				traced: !options.untraced,
			};
			types.set(
				contract.name,
				contract.kind === "local"
					? {
							...common,
							kind: "local",
							hostLifetime: contractData(contract).params.fields.length === 0,
							factory: factory as Extract<Served, { kind: "local" }>["factory"],
						}
					: { ...common, kind: "remote", factory: factory as Extract<Served, { kind: "remote" }>["factory"] },
			);
		}
		return { name, facet, types, registries, contributions: declarations.contributions };
	} catch (error) {
		throw located(error, `plugin "${name}"`);
	}
}

export type Request =
	| { readonly kind: "type"; readonly contract: Contract; readonly params: ParamsOf<Contract> }
	| { readonly kind: "registry"; readonly registry: Registry<unknown, unknown> };
export type Recorded = {
	readonly documents: readonly AnyDefinition[];
	readonly tables: readonly TableDefinition[];
	readonly jobs: readonly JobDefinition<unknown, unknown, unknown>[];
	readonly contributions: readonly Registry<unknown, unknown>[];
	readonly requests: readonly Request[];
};
const unused = new Proxy(() => {}, {
	get: (_target, property): unknown => (property === "then" ? undefined : unused),
	apply: (): unknown => unused,
});

export function recordFactory(object: ObjectsObject, served: Served, context: Context): Recorded {
	let declaring = true;
	const names = new Set<string>(),
		tables = new Map<string, TableDefinition>(),
		documents: AnyDefinition[] = [],
		jobs: JobDefinition<unknown, unknown, unknown>[] = [],
		contributions: Registry<unknown, unknown>[] = [],
		requests: Request[] = [];
	const declaration = (operation: string): void => {
		if (!declaring) throw new Error(`${object.label}: self.${operation} is valid only in the factory`);
	};
	const once = (kind: string, name: string): void => {
		const key = `${kind}:${name}`;
		if (names.has(key)) throw new Error(`${object.label}: ${kind} "${name}" is declared twice`);
		names.add(key);
	};
	const persistable = (what: string) => {
		if (served.kind !== "local" || !served.hostLifetime)
			throw new Error(`${object.label}: ${what}: persist needs a stable identity (a local type with empty params)`);
		if (!object.host.store) throw new Error(`${object.label}: ${what}: persist needs a store`);
		return object.host.store;
	};
	const claim = (what: string, namespaces: readonly string[]): void => {
		const store = persistable(what);
		for (const name of namespaces) store.claims.assertDocuments(served.contract.name, name, object);
	};
	const operations: Record<string, (...args: never[]) => unknown> = {
		state: (definition: AnyDefinition) => {
			once("state", definition.name);
			if (definition.persist) claim(`state "${definition.name}"`, ["objects"]);
			object.documents.check(definition);
			documents.push(definition);
			return unused;
		},
		table: (definition: TableDefinition) => {
			once("table", definition.name);
			persistable(`table "${definition.name}"`).claims.assertTable(
				tableSqlName(served.contract.name, definition.name),
				object,
			);
			tables.set(definition.name, definition);
			return unused;
		},
		query: (_table: unknown, query: Query, limit: unknown) => {
			const table = tables.get(query.table.name);
			if (table !== query.table) throw new Error(`${object.label}: self.query: the table is not one this factory declared`);
			checkLiveQuery(table, query, limit, object.label);
			return unused;
		},
		job: (definition: JobDefinition<unknown, unknown, unknown>) => {
			once("job", definition.name);
			if (definition.persist) claim(`job "${definition.name}"`, ["objects.jobs", "objects.job-states"]);
			object.checkJob(definition);
			jobs.push(definition);
			return unused;
		},
		get: (type: Contract, params: unknown) => {
			requests.push({ kind: "type", contract: type, params: checkParams(type, params, context).params });
			return unused;
		},
		registry: (token: Registry<unknown, unknown>) => {
			requests.push({ kind: "registry", registry: token });
			return object.host.registryRecord(token.name).value(token.version);
		},
		contribute: (token: Registry<unknown, unknown>) => {
			if (served.kind !== "local" || !served.hostLifetime)
				throw new Error(`${object.label}: self.contribute is valid only in a local type with empty params`);
			if (names.has(`registry:${token.name}`))
				throw new Error(`${object.label}: registry ${token.name} is contributed to twice`);
			names.add(`registry:${token.name}`);
			contributions.push(token);
		},
		retryOn: (...sources: readonly unknown[]) => {
			for (const source of sources) retrySource(source, object.label);
		},
		derive: () => unused,
		writable: () => unused,
		follow: () => unused,
		on: () => undefined,
		onLive: () => undefined,
		open: () => {
			return unused;
		},
		tx: () => {
			throw new Error(`${object.label}: self.tx runs in calls, not in a factory`);
		},
	};
	const self = new Proxy(
		{},
		{
			get: (_target, key) =>
				typeof key !== "string" || !Object.hasOwn(operations, key)
					? undefined
					: (...args: never[]) => {
							declaration(String(key));
							return operations[String(key)]?.(...args) ?? unused;
						},
		},
	) as StoreSelf;
	try {
		if (served.kind === "local") served.factory(object.params, self);
		else served.factory(object.params, object.principal!, self);
	} catch (error) {
		throw located(error, `plugin "${served.plugin}", ${object.label}`);
	} finally {
		declaring = false;
	}
	return { tables: [...tables.values()], documents, jobs, contributions, requests };
}
