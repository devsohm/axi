import type { Ctx } from "./types.ts";

export interface Registry<V> {
	readonly name: string;
	readonly conflict: "error" | "last";
	readonly value?: V;
}
export function defineRegistry<V>(name: string, options: { conflict?: "error" | "last" } = {}): Registry<V> {
	return { name, conflict: options.conflict ?? "error" };
}
export type RegistryTable<V> = ReadonlyMap<string, V>;
export interface RegistryView<V> {
	table(ctx?: Ctx): RegistryTable<V>;
	get(key: string, ctx?: Ctx): V | undefined;
	subscribe(listener: (table: RegistryTable<V>, codeVersion: number) => void): () => void;
}
export interface Registration {
	readonly registry: Registry<unknown>;
	readonly key: string;
	readonly value: unknown;
}
