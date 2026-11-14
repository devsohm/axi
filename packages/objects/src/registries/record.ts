import { ObjectsError } from "../data/index.ts";
import { invalid } from "../data/internal.ts";
import { type Batch, handedOut, type NativeStart } from "../state/internal.ts";
import type { RegistryContribution } from "./contribution.ts";
import type { RegistryConflict, RegistryEntry, RegistryProvider, RegistryTable } from "./registry.ts";
import { RegistryValueSource } from "./value.ts";
import type { UnboundClock } from "../host/unbound-clock.ts";

export type RegistryError =
	| { readonly kind: "registry_undeclared"; readonly registry: string; readonly plugins: readonly string[] }
	| {
			readonly kind: "registry_conflict";
			readonly registry: string;
			readonly message: string;
			readonly plugins: readonly string[];
	  }
	| { readonly kind: "registry_failed"; readonly registry: string; readonly error: unknown }
	| {
			readonly kind: "contribution_failed";
			readonly registry: string;
			readonly plugin: string;
			readonly type?: string;
			readonly error: unknown;
	  }
	| {
			readonly kind: "contribution_refused";
			readonly registry: string;
			readonly plugin: string;
			readonly type?: string;
			readonly version: number;
	  };
type Provider = { version: number; provider: RegistryProvider<unknown, unknown> };
type Composition = {
	good: { value: unknown; from: readonly RegistryContribution[] } | undefined;
	failure: { error: unknown } | undefined;
};

export function checkRegistryProvider(name: string, provider: RegistryProvider<unknown, unknown>): void {
	if (typeof provider?.compose !== "function") throw new Error(`registry ${name}: compose is a function`);
}

export class RegistryRecord {
	readonly name: string;
	readonly clock: UnboundClock | undefined;
	readonly #batch: Batch;
	readonly #report: (error: RegistryError) => void;
	#provider: Provider | undefined;
	#contributions: readonly RegistryContribution[] = [];
	#table: RegistryTable<unknown> | undefined;
	#dirty = true;
	#composition: Composition = { good: undefined, failure: undefined };
	#composing = false;
	#conflicts = new Set<string>();
	#undeclared: string | undefined;
	readonly #values = new Map<number, RegistryValueSource>();
	constructor(name: string, batch: Batch, report: (error: RegistryError) => void, clock?: UnboundClock) {
		this.name = name;
		this.#batch = batch;
		this.#report = report;
		this.clock = clock;
	}
	get providedVersion(): number | undefined {
		return this.#provider?.version;
	}
	get newestContribution(): number | undefined {
		return this.#contributions.length ? Math.max(...this.#contributions.map(({ version }) => version)) : undefined;
	}
	reportUndeclared(): void {
		if (this.#provider) {
			this.#undeclared = undefined;
			return;
		}
		if (!this.#contributions.length) return;
		const plugins = [...new Set(this.#contributions.map(({ contributor }) => contributor.plugin))];
		const key = plugins.join("\0");
		if (key !== this.#undeclared) {
			this.#undeclared = key;
			this.#report({ kind: "registry_undeclared", registry: this.name, plugins });
		}
	}
	value(version: number): RegistryValueSource {
		let source = this.#values.get(version);
		if (!source) {
			source = new RegistryValueSource(this, version, this.#batch);
			this.#values.set(version, source);
		}
		return source;
	}
	serve(version: number, provider: RegistryProvider<unknown, unknown>): void {
		checkRegistryProvider(this.name, provider);
		this.#provider = { version, provider };
		this.#table = undefined;
		this.#invalidate();
	}
	unserve(): void {
		this.#provider = undefined;
		this.#table = undefined;
		this.#composition = { good: undefined, failure: undefined };
		this.#invalidate();
	}
	composeServed(): void {
		if (this.#provider) {
			this.#invalidate();
			this.start();
		}
	}
	add(contribution: RegistryContribution): void {
		const at = this.#contributions.findIndex((other) => order(contribution, other) < 0);
		this.#contributions = this.#contributions.toSpliced(at < 0 ? this.#contributions.length : at, 0, contribution);
		contribution.follow();
		this.#invalidate();
	}
	remove(contribution: RegistryContribution): void {
		const at = this.#contributions.indexOf(contribution);
		if (at < 0) return;
		this.#contributions = this.#contributions.toSpliced(at, 1);
		contribution.unfollow();
		this.#invalidate();
	}
	contributionChanged(): void {
		this.#invalidate();
	}
	start(): NativeStart<unknown> {
		if (this.#composing) throw invalid("cycle", `registry ${this.name} is read while it composes`);
		if (!this.#provider)
			return {
				kind: "failed",
				error: new ObjectsError({
					code: "unavailable",
					reason: "undeclared",
					message: `registry ${this.name}: no plugin serves it here`,
				}),
				last: undefined,
			};
		if (this.#dirty) this.#compose(this.#provider);
		const { good, failure } = this.#composition;
		return failure ? { kind: "failed", error: failure.error, last: good } : { kind: "value", value: good!.value };
	}
	get composedFrom(): readonly RegistryContribution[] | undefined {
		return this.#composition.good?.from;
	}
	inTable(from: readonly RegistryContribution[]): boolean {
		return from === this.#contributions || from.every((entry) => this.#contributions.includes(entry));
	}
	valueAdapter(version: number): ((current: never) => unknown) | undefined {
		return this.#provider?.provider.accepts?.[version]?.value;
	}
	adapt<T>(adapter: () => T): T {
		this.#batch.count("objects.registry.adapts");
		return this.#batch.compute(adapter);
	}
	reportContribution(error: RegistryError): void {
		this.#report(error);
	}
	failed(error: unknown): void {
		this.#report({ kind: "registry_failed", registry: this.name, error: handedOut(error) });
	}
	close(): void {
		for (const contribution of this.#contributions) contribution.unfollow();
		this.#contributions = [];
		this.#table = undefined;
		this.#dirty = false;
		for (const source of this.#values.values()) source.close();
		this.#values.clear();
	}
	#invalidate(): void {
		const alreadyDirty = this.#dirty;
		this.#dirty = true;
		for (const source of this.#values.values()) {
			if (alreadyDirty) source.relisted();
			else source.recomposed();
		}
	}
	#compose({ version, provider }: Provider): void {
		this.#dirty = false;
		this.#composing = true;
		try {
			const table: RegistryEntry<unknown>[] = [];
			for (const contribution of this.#contributions) {
				const entry = contribution.entry(version, provider);
				if (entry) table.push(entry);
			}
			if (
				this.#table &&
				table.length === this.#table.length &&
				table.every((entry, i) => entry === this.#table![i]) &&
				(this.#composition.good || this.#composition.failure)
			)
				return;
			this.#table = table;
			const conflicts = new Map<string, RegistryConflict>();
			let value: unknown;
			try {
				this.#batch.count("objects.registry.composes");
				value = this.#batch.compute(() =>
					provider.compose(table, {
						report: (conflict) => {
							conflicts.set(`${conflict.message}\0${conflict.plugins.join("\0")}`, conflict);
						},
					}),
				);
			} catch (error) {
				if (!this.#composition.failure) this.failed(error);
				const { good } = this.#composition;
				this.#composition = { good: good && this.inTable(good.from) ? good : undefined, failure: { error } };
				return;
			}
			this.#composition = { good: { value, from: this.#contributions }, failure: undefined };
			for (const [key, conflict] of conflicts)
				if (!this.#conflicts.has(key)) this.#report({ kind: "registry_conflict", registry: this.name, ...conflict });
			this.#conflicts = new Set(conflicts.keys());
		} finally {
			this.#composing = false;
		}
	}
}
function order(a: RegistryContribution, b: RegistryContribution): number {
	const left = a.contributor,
		right = b.contributor;
	if (left.plugin !== right.plugin) return left.plugin < right.plugin ? -1 : 1;
	const first = left.type ?? "",
		second = right.type ?? "";
	return first === second ? 0 : first < second ? -1 : 1;
}
