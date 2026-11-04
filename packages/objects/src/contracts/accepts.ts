import type { Context } from "../context/index.ts";
import { LOCAL, contractData, type Contract, type Kind, type ShapeOf } from "./contract.ts";
import { checkKeys, entriesOf } from "./declare.ts";
import type { Change, ChangesAfter, CurrentStep, MemberNames, MethodAt, OlderVersions, StepAt, Variants, VariantsWith, VariantShape } from "./history.ts";
import type { Method, Static } from "./schema.ts";

type Defined<T> = { readonly [K in keyof T as [T[K]] extends [never] ? never : K]: T[K] };
type Section<K extends string, T> = [keyof T] extends [never] ? { readonly [P in K]?: Readonly<Record<string, never>> } : { readonly [P in K]: T };
type StateMappings<Old extends VariantShape, Now extends VariantShape, X, Changes extends Change> = Defined<{
	[M in keyof Old["state"]]: M extends keyof Now["state"]
		? [X, M, "state"] extends Changes ? (current: Static<Now["state"][M]>) => Static<Old["state"][M]> : never
		: "refuse" | ((state: { [F in keyof Now["state"]]: Static<Now["state"][F]> }) => Static<Old["state"][M]>);
}>;
type RemoteState<Old extends Variants, Now extends Variants, Changes extends Change> = Defined<{
	[X in keyof Old & keyof Now]: [keyof StateMappings<Old[X], Now[X], X, Changes>] extends [never] ? never : StateMappings<Old[X], Now[X], X, Changes>;
}>;
type KeyedMappings<Old extends VariantShape, Now extends VariantShape, C extends Change> = Defined<{
	[M in keyof NonNullable<Old["keyed"]>]: M extends keyof NonNullable<Now["keyed"]>
		? [typeof LOCAL, M, "keyed"] extends C ? "refuse" | ((value: Static<NonNullable<Now["keyed"]>[M]>) => Static<NonNullable<Old["keyed"]>[M]>) : never
		: "refuse";
}>;
type Replaced<M extends Method> = "refuse" | { readonly call: (args: Static<M["args"]>, context: Context) => Promise<Static<M["result"]>>; readonly args?: never; readonly result?: never };
type Removed<V extends Variants, X, M> = X extends keyof V ? M extends keyof V[X]["methods"] ? never : X : never;
type Changed<C, X, M, Side> = X extends unknown ? [X, M, Side] extends C ? true : never : never;
type Adapt<A, R, Old extends Method, Now extends Method> = [A | R] extends [never] ? never
	: Replaced<Old> | ({ readonly call?: never } & ([A] extends [never] ? { readonly args?: never }
		: { readonly args: (old: Static<Old["args"]>) => Static<Now["args"]> }) & ([R] extends [never] ? { readonly result?: never }
		: { readonly result: (current: Static<Now["result"]>) => Static<Old["result"]> }));
type MethodMappings<Old extends Variants, Now extends Variants, C extends Change> = Defined<{
	[M in MemberNames<Old, "methods">]: [Removed<Now, VariantsWith<Old, M>, M>] extends [never]
		? Adapt<Changed<C, VariantsWith<Old, M>, M, "args">, Changed<C, VariantsWith<Old, M>, M, "result">, MethodAt<Old, M>, MethodAt<Now, M>> : Replaced<MethodAt<Old, M>>;
}>;
type Mappings<K extends Kind, Old extends Variants, Now extends Variants, C extends Change> =
	Section<"state", K extends "local" ? StateMappings<Old[typeof LOCAL], Now[typeof LOCAL], typeof LOCAL, C> : RemoteState<Old, Now, C>> &
	Section<"methods", MethodMappings<Old, Now, C>> &
	Section<"keyed", K extends "local" ? KeyedMappings<Old[typeof LOCAL], Now[typeof LOCAL], C> : Record<never, never>>;
export type AcceptsTable<C extends Contract> = {
	readonly [V in OlderVersions<ShapeOf<C>["history"]>]?: Mappings<ShapeOf<C>["kind"], StepAt<ShapeOf<C>["history"], V>["variants"],
		CurrentStep<ShapeOf<C>["history"]>["variants"], ChangesAfter<ShapeOf<C>["history"], V>>;
};
export type AcceptedVersion = { readonly version: number; readonly fingerprint: string };
type StateNeed = "removed" | "changed";
type MethodNeed = { removed: boolean; args: boolean; result: boolean };
function section<N>(raw: unknown, required: ReadonlyMap<string, N>, path: string, check: (value: unknown, need: N, path: string) => void): void {
	const supplied = new Map(raw === undefined ? [] : entriesOf(raw, path));
	for (const name of supplied.keys()) if (!required.has(name)) throw new Error(`${path}.${name}: unnecessary mapping`);
	for (const [name, need] of required) {
		if (!supplied.has(name)) throw new Error(`${path}.${name}: missing mapping`);
		check(supplied.get(name), need, `${path}.${name}`);
	}
}
function stateMapping(raw: unknown, need: StateNeed, path: string): void {
	if (typeof raw !== "function" && !(need === "removed" && raw === "refuse"))
		throw new Error(`${path}: expected ${need === "removed" ? 'a function or "refuse"' : "a function"}`);
}
function keyedMapping(raw: unknown, need: StateNeed, path: string): void {
	if (raw !== "refuse" && !(need === "changed" && typeof raw === "function"))
		throw new Error(`${path}: expected ${need === "changed" ? 'a function or "refuse"' : '"refuse"'}`);
}
function methodMapping(raw: unknown, need: MethodNeed, path: string): void {
	if (raw === "refuse") return;
	checkKeys(raw, ["args", "result", "call"], path);
	const fields = raw as Record<string, unknown>;
	if (need.removed || fields.call !== undefined) {
		if (typeof fields.call !== "function" || fields.args !== undefined || fields.result !== undefined)
			throw new Error(`${path}: expected { call } or "refuse"`);
		return;
	}
	for (const key of ["args", "result"] as const) {
		const supplied = fields[key];
		if (!need[key] && supplied !== undefined) throw new Error(`${path}.${key}: unnecessary mapping`);
		if (need[key] && supplied === undefined) throw new Error(`${path}.${key}: missing mapping`);
		if (need[key] && typeof supplied !== "function") throw new Error(`${path}.${key}: expected a function`);
	}
}
export function checkAccepts<C extends Contract>(contract: C, accepts: AcceptsTable<C>): { readonly versions: readonly AcceptedVersion[] } {
	const data = contractData(contract), current = data.versions.at(-1)!;
	const versions = entriesOf(accepts, `${data.name} accepts`).map(([key, raw]) => {
		const path = `${data.name} accepts[${key}]`, index = data.versions.findIndex((item) => String(item.version) === key);
		if (index < 0 || index === data.versions.length - 1) throw new Error(`${path}: not an older version`);
		const old = data.versions[index]!;
		const edits = new Set(data.versions.slice(index + 1).flatMap((item) => item.changes.map((change) => JSON.stringify(change))));
		const changed = (variant: string, member: string, side: Change[2]) => edits.has(JSON.stringify([variant, member, side]));
		const states = new Map<string, Map<string, StateNeed>>(), methods = new Map<string, MethodNeed>(), keyed = new Map<string, StateNeed>();
		for (const [variant, previous] of old.variants) {
			const now = current.variants.get(variant)!, needs = new Map<string, StateNeed>();
			for (const member of previous.keyed.keys()) {
				if (!now.keyed.has(member)) keyed.set(member, "removed");
				else if (changed(variant, member, "keyed")) keyed.set(member, "changed");
			}
			for (const member of previous.state.keys()) {
				if (!now.state.has(member)) needs.set(member, "removed");
				else if (changed(variant, member, "state")) needs.set(member, "changed");
			}
			if (needs.size) states.set(variant, needs);
			for (const member of previous.methods.keys()) {
				const need = methods.get(member) ?? { removed: false, args: false, result: false };
				need.removed ||= !now.methods.has(member);
				need.args ||= changed(variant, member, "args");
				need.result ||= changed(variant, member, "result");
				methods.set(member, need);
			}
		}
		checkKeys(raw, ["state", "methods", "keyed"], path);
		const mappings = raw as Record<string, unknown>;
		const variantSection = (value: unknown, needs: ReadonlyMap<string, StateNeed>, at: string) => section(value, needs, at, stateMapping);
		if (data.kind === "local") variantSection(mappings.state, states.get(LOCAL) ?? new Map(), `${path}.state`);
		else section(mappings.state, states, `${path}.state`, variantSection);
		section(mappings.methods, new Map([...methods].filter(([, need]) => need.removed || need.args || need.result)), `${path}.methods`, methodMapping);
		section(mappings.keyed, keyed, `${path}.keyed`, keyedMapping);
		return { version: old.version, fingerprint: old.fingerprint };
	});
	return { versions };
}
