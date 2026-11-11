import type { TNull } from "typebox";
import type { Context } from "../context/index.ts";
import type { Watchable, WatchHandle } from "../watch.ts";
import type { Change, CurrentStep, History, VariantShape, Variants } from "./history.ts";
import type { Address, KindShape } from "./host-kind.ts";
import type { Params, ParamsData } from "./params.ts";
import type { Method, Static } from "./schema.ts";
import type { Snapshot } from "./snapshot.ts";

export type Kind = "remote" | "local";
export const LOCAL = "members";
export type ContractShape = { readonly kind: Kind; readonly name: string; readonly params: Params; readonly history: History };
export interface Contract<S extends ContractShape = ContractShape> {
	readonly kind: S["kind"]; readonly name: S["name"]; readonly version: number;
	readonly fingerprint: string; readonly "~shape"?: S;
}
export type ShapeOf<C extends Contract> = NonNullable<C["~shape"]>;
export type CurrentVariants<C extends Contract> = CurrentStep<ShapeOf<C>["history"]>["variants"];
export type ParamsOf<C extends Contract> = { [F in keyof ShapeOf<C>["params"]]: Static<ShapeOf<C>["params"][F]> };
type Call<M extends Method, X extends Context> = M["args"] extends TNull
	? (context: X) => Promise<Static<M["result"]>> : (args: Static<M["args"]>, context: X) => Promise<Static<M["result"]>>;
export interface KeyedWatchable<T, Key = string> {
	get(key: Key, context: Context): Promise<T | undefined>;
	watch(key: Key, context: Context): Promise<WatchHandle<T> | undefined>;
	at(key: Key): Watchable<T>;
}
export interface EventSubscription {
	stop(): void;
}
export interface EventMember<T> {
	on(listener: (event: { readonly value: T; readonly at: number }) => void, ctx: Context): Promise<EventSubscription>;
}
export interface EventSource<T> extends EventMember<T> {
	emit(value: T): void;
}
export type HostKeyed<S, K extends KindShape> = S & { readonly "~key"?: K };
export type KeyOfMember<S> = S extends { readonly "~key"?: infer K }
	? K extends KindShape
		? Address<K>
		: string
	: string;
export type VariantImplementation<V extends VariantShape, X extends Context = Context> = {
	[M in
		| keyof V["state"]
		| keyof V["methods"]
		| keyof NonNullable<V["keyed"]>
		| keyof NonNullable<V["events"]>]: M extends keyof V["methods"]
		? Call<V["methods"][M], X>
		: M extends keyof V["state"]
			? Watchable<Static<V["state"][M]>>
			: M extends keyof NonNullable<V["keyed"]>
				? KeyedWatchable<Static<NonNullable<V["keyed"]>[M]>, KeyOfMember<NonNullable<V["keyed"]>[M]>>
				: M extends keyof NonNullable<V["events"]>
					? EventMember<Static<NonNullable<V["events"]>[M]>>
					: never;
};
type Implement<K extends Kind, V extends Variants, X extends Context> = K extends "local"
	? VariantImplementation<V[typeof LOCAL], X> : { [N in keyof V]: { readonly variant: N; readonly members: VariantImplementation<V[N], X> } }[keyof V];
export type Implementation<C extends Contract, X extends Context = Context> = Implement<ShapeOf<C>["kind"], CurrentVariants<C>, X>;
export type MemberKind = "state" | "method" | "keyed" | "event";
export type HostAddress = (params: ParamsOf<Contract>) => Address;
export type MethodData = { readonly args: Snapshot; readonly result: Snapshot };
export type KeyedSnapshot = Snapshot & { readonly key?: KindShape };
export type VariantData = {
	readonly state: ReadonlyMap<string, Snapshot>;
	readonly methods: ReadonlyMap<string, MethodData>;
	readonly keyed: ReadonlyMap<string, KeyedSnapshot>;
	readonly events: ReadonlyMap<string, Snapshot>;
};
export type VersionData = {
	readonly version: number;
	readonly fingerprint: string;
	readonly variants: ReadonlyMap<string, VariantData>;
	readonly changes: readonly Change[];
};
export type ContractData = {
	readonly kind: Kind;
	readonly name: string;
	readonly params: ParamsData;
	readonly hostAddress: HostAddress | undefined;
	readonly versions: readonly VersionData[];
	readonly kinds: ReadonlyMap<string, MemberKind>;
};
const declarations = new WeakMap<Contract, ContractData>();
export function createContract<C extends Contract>(data: ContractData): C {
	const latest = data.versions.at(-1)!;
	const contract: Contract = { kind: data.kind, name: data.name, version: latest.version, fingerprint: latest.fingerprint };
	declarations.set(contract, data);
	return contract as C;
}
export function contractData(contract: Contract): ContractData {
	const found = declarations.get(contract);
	if (!found) throw new Error(`${contract.name}: not a declared contract (spread and hand-built copies are refused)`);
	return found;
}
export function takesNoArgs(method: MethodData): boolean {
	const node = method.args.normal;
	return node !== null && typeof node === "object" && !Array.isArray(node) && node.type === "null" && Object.keys(node).length === 1;
}
export function currentVariants(contract: Contract): ReadonlyMap<string, VariantData> { return contractData(contract).versions.at(-1)!.variants; }
export function variantsAt(contract: Contract, version: number): ReadonlyMap<string, VariantData> {
	return contractData(contract).versions.find(item => item.version === version)!.variants;
}
export function variantOrder(contract: Contract): readonly string[] { return [...currentVariants(contract).keys()].sort(); }
export type VariantNames = {
	readonly state: readonly string[];
	readonly methods: readonly string[];
	readonly events: readonly string[];
};
const noEvents: readonly string[] = [];
export function variantNames(variant: VariantData): VariantNames {
	return {
		state: [...variant.state.keys()].sort(),
		methods: [...variant.methods.keys()].sort(),
		events: variant.events.size ? [...variant.events.keys()].sort() : noEvents,
	};
}
