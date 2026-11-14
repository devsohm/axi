import type { Context } from "../context/index.ts";
import type { NativeWatchable, Watchable } from "../watch.ts";
import { checkName } from "../contracts/names.ts";
import type { NativeObservation, NativeObserver } from "../state/observation.ts";

export type Registry<C, V> = {
	readonly kind: "registry";
	readonly name: string;
	readonly version: number;
	readonly "~types"?: (contribution: C) => V;
};
export type RegistryEntry<C> = {
	readonly plugin: string;
	readonly type?: string;
	readonly version: number;
	readonly value: C;
};
export type RegistryTable<C> = readonly RegistryEntry<C>[];
export type RegistryConflict = { readonly message: string; readonly plugins: readonly string[] };
export type ComposeContext = { report(conflict: RegistryConflict): void };
export type RegistryAccepts<C, V> = {
	readonly [version: number]: {
		readonly contribution?: (old: never) => C;
		readonly value?: (current: V) => unknown;
	};
};
export type RegistryProvider<C, V> = {
	readonly compose: (table: RegistryTable<C>, context: ComposeContext) => V;
	readonly accepts?: RegistryAccepts<C, V>;
};
export type Contribution<C> = C | Watchable<C> | NativeWatchable<C>;
export interface RegistryValue<V> extends NativeWatchable<V> {
	observe(observer: NativeObserver<V>, context: Context): NativeObservation<V>;
}
export function defineRegistry<C, V>(name: string, options: { readonly version: number }): Registry<C, V> {
	checkName(name, "registry");
	const version = options.version;
	if (!Number.isSafeInteger(version) || version < 1) throw new Error(`${name}.version: expected a positive integer`);
	return { kind: "registry", name, version };
}
