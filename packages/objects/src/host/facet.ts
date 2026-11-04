import type { Watchable } from "../watch.ts";
import type { AcceptsTable, Contract } from "../contracts/index.ts";
import type { Principal } from "../data/index.ts";
import type { Contribution, Registry, RegistryProvider } from "../registries/index.ts";
import type { Factory } from "./attempt.ts";
import type { Presence } from "./presence.ts";

export type ServeOptions<C extends Contract = Contract> = { readonly linger?: number; readonly accepts?: AcceptsTable<C>; readonly untraced?: true };
export interface FacetHost<P extends Principal = Principal> {
	serve<C extends Contract>(type: C, factory: Factory<C, P>, options?: ServeOptions<C>): void;
	serve<C, V>(registry: Registry<C, V>, provider: RegistryProvider<C, V>): void;
	references<C extends Contract>(type: C): Watchable<readonly Presence<C, P>[]>;
}
export interface FacetSelf {
	contribute<C>(registry: Registry<C, unknown>, value: Contribution<C>): void;
}
export type Facet<P extends Principal> = {
	readonly setup: (host: FacetHost<P>, self: FacetSelf) => void;
	readonly "~principal"?: (principal: P) => P;
};
type ServedFactory = (params: never, principalOrSelf: never, self: never) => unknown;
export type ServedEntry =
	| {
			readonly kind: "type";
			readonly contract: Contract;
			readonly factory: ServedFactory;
			readonly options: ServeOptions;
	  }
	| {
			readonly kind: "registry";
			readonly registry: Registry<unknown, unknown>;
			readonly provider: RegistryProvider<unknown, unknown>;
	  };
export type FacetContribution = { readonly registry: Registry<unknown, unknown>; readonly value: unknown };
export function defineFacet<P extends Principal>(setup: (host: FacetHost<P>, self: FacetSelf) => void): Facet<P> {
	return { setup };
}

export function setUp<P extends Principal>(
	name: string,
	facet: Facet<P>,
	references: <C extends Contract>(type: C) => Watchable<readonly Presence<C, P>[]>,
): { readonly served: readonly ServedEntry[]; readonly contributions: readonly FacetContribution[] } {
	const served: ServedEntry[] = [],
		contributions: FacetContribution[] = [];
	let declaring = true;
	const assert = (operation: string): void => {
		if (!declaring) throw new Error(`${name}: ${operation} is valid only in the facet's setup`);
	};
	const host: FacetHost<P> = {
		references,
		serve(type: Contract | Registry<unknown, unknown>, implementation: unknown, options: ServeOptions = {}) {
			assert("host.serve");
			if (type.kind === "registry")
				served.push({
					kind: "registry",
					registry: type,
					provider: implementation as RegistryProvider<unknown, unknown>,
				});
			else served.push({ kind: "type", contract: type, factory: implementation as ServedFactory, options });
		},
	};
	const self: FacetSelf = {
		contribute(registry, value) {
			assert("self.contribute");
			if (contributions.some((item) => item.registry.name === registry.name))
				throw new Error(`${name}: registry ${registry.name} is contributed to twice`);
			contributions.push({ registry: registry as Registry<unknown, unknown>, value });
		},
	};
	try {
		facet.setup(host, self);
	} finally {
		declaring = false;
	}
	return { served, contributions };
}
