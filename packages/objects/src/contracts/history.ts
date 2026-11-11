import type { Method, TSchema } from "./schema.ts";

export type VariantShape = {
	readonly state: Readonly<Record<string, TSchema>>;
	readonly methods: Readonly<Record<string, Method>>;
	readonly keyed?: Readonly<Record<string, TSchema>>;
	readonly events?: Readonly<Record<string, TSchema>>;
};
export type Variants = Readonly<Record<string, VariantShape>>;
export type Change = readonly [variant: string, member: string, side: "state" | "args" | "result" | "keyed" | "event"];
type Step = { readonly version: string; readonly variants: Variants; readonly changes: Change };
export type History = readonly Step[];
export type CurrentStep<H extends History> = H extends readonly [...Step[], infer Tail extends Step] ? Tail : never;
export type StepAt<H extends History, V extends string> = Extract<H[number], { readonly version: V }>;
export type OlderVersions<H extends History> = H extends readonly [...infer Before extends Step[], Step] ? Before[number]["version"] : never;
export type ChangesAfter<H extends History, V extends string> = H extends readonly [infer First extends Step, ...infer Rest extends Step[]]
	? First["version"] extends V ? Rest[number]["changes"] : ChangesAfter<Rest, V> : never;
export type MemberNames<V extends Variants, S extends keyof VariantShape> = { [N in keyof V]: keyof V[N][S] }[keyof V] & string;
export type VariantsWith<V extends Variants, M> = { [N in keyof V]: M extends keyof V[N]["methods"] ? N : never }[keyof V] & string;
export type MethodAt<V extends Variants, M> = { [N in keyof V]: M extends keyof V[N]["methods"] ? V[N]["methods"][M] : never }[keyof V];
type Next = { "0": "1"; "1": "2"; "2": "3"; "3": "4"; "4": "5"; "5": "6"; "6": "7"; "7": "8"; "8": "9"; "9": "0" };
type Digits<S extends string> = S extends `${infer Head extends keyof Next}${infer Tail}` ? [Head, ...Digits<Tail>] : [];
type Carry<D extends (keyof Next)[]> = D extends [...infer Before extends (keyof Next)[], infer Last extends keyof Next]
	? Last extends "9" ? [...Carry<Before>, "0"] : [...Before, Next[Last]] : ["1"];
type Join<D extends string[]> = D extends [infer Head extends string, ...infer Tail extends string[]] ? `${Head}${Join<Tail>}` : "";
export type Increment<N extends string> = Join<Carry<Digits<N>>>;
