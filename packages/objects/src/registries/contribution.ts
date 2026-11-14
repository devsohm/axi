import { type Dependent, type DeriveSource, handedOut, type NativeSource, Source } from "../state/internal.ts";
import type { RegistryRecord } from "./record.ts";
import type { RegistryEntry, RegistryProvider } from "./registry.ts";

export type Contributor = { readonly plugin: string; readonly type: string | undefined };
export type ContributionContent =
	| { readonly kind: "plain"; readonly value: unknown }
	| { readonly kind: "json"; readonly source: DeriveSource }
	| { readonly kind: "native"; readonly source: NativeSource };

export class RegistryContribution implements Dependent {
	readonly record: RegistryRecord;
	readonly contributor: Contributor;
	readonly version: number;
	readonly #content: ContributionContent;
	#adapted: { from: unknown; adapter: (old: never) => unknown; value: unknown } | undefined;
	#entry: RegistryEntry<unknown> | undefined;
	#excluded: "none" | "failed" | "refused" = "none";
	constructor(record: RegistryRecord, contributor: Contributor, version: number, content: ContributionContent) {
		this.record = record;
		this.contributor = contributor;
		this.version = version;
		this.#content = content;
	}
	invalidate(): void {
		this.record.contributionChanged();
	}
	sourceRetired(): void {}
	follow(): void {
		this.#source()?.dependents.add(this);
	}
	unfollow(): void {
		this.#source()?.dependents.delete(this);
	}
	entry(version: number, provider: RegistryProvider<unknown, unknown>): RegistryEntry<unknown> | undefined {
		const adapt = this.version < version ? provider.accepts?.[this.version]?.contribution : undefined;
		if (this.version > version || (this.version < version && !adapt)) {
			if (this.#excluded !== "refused") {
				this.#excluded = "refused";
				this.record.reportContribution({
					kind: "contribution_refused",
					registry: this.record.name,
					...this.#identity(),
					version: this.version,
				});
			}
			return undefined;
		}
		let value: unknown;
		try {
			const content = this.#content;
			const raw =
				content.kind === "plain"
					? content.value
					: content.kind === "json"
						? content.source.value
						: content.source.current();
			if (!adapt) value = raw;
			else if (this.#adapted && this.#adapted.from === raw && this.#adapted.adapter === adapt)
				value = this.#adapted.value;
			else {
				value = this.record.adapt(() => adapt(raw as never));
				this.#adapted = { from: raw, adapter: adapt, value };
			}
		} catch (error) {
			if (this.#excluded !== "failed") {
				this.#excluded = "failed";
				this.record.reportContribution({
					kind: "contribution_failed",
					registry: this.record.name,
					...this.#identity(),
					error: handedOut(error),
				});
			}
			return undefined;
		}
		this.#excluded = "none";
		if (this.#entry && this.#entry.value === value) return this.#entry;
		this.#entry = { ...this.#identity(), version: this.version, value };
		return this.#entry;
	}
	#source(): Source | NativeSource | undefined {
		const content = this.#content;
		return content.kind === "native"
			? content.source
			: content.kind === "json" && content.source instanceof Source
				? content.source
				: undefined;
	}
	#identity(): { plugin: string; type?: string } {
		const { plugin, type } = this.contributor;
		return type === undefined ? { plugin } : { plugin, type };
	}
}
