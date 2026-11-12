import type { Context } from "../context/index.ts";
import { isObjectsError, type Principal } from "../data/index.ts";
import type {
	CommittedReload,
	Facet,
	Host,
	LoadReport,
	PluginFacet,
	PluginFailure,
	ReloadReport,
} from "../host/index.ts";

export type Prepared =
	| { readonly kind: "facet"; readonly facet: Facet<Principal>; readonly digest: string }
	| { readonly kind: "failed"; readonly error: unknown };
export type SetEntry = { readonly name: string; readonly digest: string | undefined; prepare(): Prepared };
type Ready = Extract<Prepared, { kind: "facet" }>;
export class LoadedFacets {
	readonly #core: readonly PluginFacet<Principal>[];
	#current: Map<string, Ready>;
	#tail: Promise<void> = Promise.resolve();
	private constructor(core: readonly PluginFacet<Principal>[], current: Map<string, Ready>) {
		this.#core = core;
		this.#current = current;
	}
	static async load<P extends Principal>(
		host: Host<P>,
		core: readonly PluginFacet<P>[],
		entries: readonly SetEntry[],
		context: Context,
	): Promise<{ readonly loaded: LoadedFacets; readonly report: LoadReport }> {
		// The host validates duplicate names before the cache merges them.
		const ready = new Map<string, Ready>(),
			failed: PluginFailure[] = [],
			facets: PluginFacet<P>[] = [];
		for (const entry of entries) {
			const prepared = entry.prepare();
			if (prepared.kind === "failed") failed.push({ plugin: entry.name, error: prepared.error });
			else {
				ready.set(entry.name, prepared);
				facets.push({ name: entry.name, facet: prepared.facet as unknown as Facet<P> });
			}
		}
		const report = await host.load([...core, ...facets], context);
		for (const failure of report.failed) ready.delete(failure.plugin);
		return {
			loaded: new LoadedFacets(core as unknown as readonly PluginFacet<Principal>[], ready),
			report: { failed: failed.concat(report.failed) },
		};
	}
	reload<P extends Principal>(host: Host<P>, entries: readonly SetEntry[], context: Context): Promise<ReloadReport> {
		const run = this.#tail.then(async () => {
			const next = new Map<string, Ready>(),
				failed: PluginFailure[] = [];
			for (const entry of entries) {
				const old = this.#current.get(entry.name);
				if (old && entry.digest !== undefined && old.digest === entry.digest) {
					next.set(entry.name, old);
					continue;
				}
				const result = entry.prepare();
				if (result.kind === "facet") next.set(entry.name, result);
				else {
					failed.push({ plugin: entry.name, error: result.error });
					if (old) next.set(entry.name, old);
				}
			}
			const adopt = (kept: readonly string[]): void => {
				for (const name of kept) {
					const old = this.#current.get(name);
					if (old) next.set(name, old);
					else next.delete(name);
				}
				this.#current = next;
			};
			try {
				const plugins = [...this.#core, ...Array.from(next, ([name, value]) => ({ name, facet: value.facet }))];
				const report = await host.reload(plugins as unknown as readonly PluginFacet<P>[], context, { failed });
				adopt(report.failed.map((entry) => entry.plugin));
				return report;
			} catch (error) {
				if (isObjectsError(error, "aborted") && error.details && typeof error.details === "object") {
					const committed = Reflect.get(error.details, "committed") as CommittedReload | undefined;
					if (committed) adopt(committed.failed);
				}
				throw error;
			}
		});
		this.#tail = run.then(
			() => {},
			() => {},
		);
		return run;
	}
}
