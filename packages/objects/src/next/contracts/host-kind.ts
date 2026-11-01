import { checkName } from "./names.ts";
import { type Params, type ParamsData, type RequiredFields, readParams, joinKey } from "./params.ts";
import type { Static } from "./schema.ts";

export type KindShape = { readonly kind: string; readonly "~params"?: Params };
export type ParamsOfKind<K extends KindShape> = { [F in keyof NonNullable<K["~params"]>]: Static<NonNullable<K["~params"]>[F]> };
export type Address<K extends KindShape = KindShape> = { readonly kind: K["kind"]; readonly params: ParamsOfKind<K>; readonly key: string };
export interface HostKind<N extends string = string, P extends Params = Params> {
	(...params: keyof P extends never ? [params?: Record<never, never>] : [params: { [F in keyof P]: Static<P[F]> }]): Address<HostKind<N, P>>;
	readonly kind: N;
	readonly "~params"?: P;
}
const declarations = new WeakMap<object, ParamsData>();
export function hostKind<const N extends string, const P extends Params = Record<never, never>>(name: N, params?: P & NoInfer<RequiredFields<P>>): HostKind<N, P> {
	checkName(name, "A host kind's name");
	if (name === "client") throw new Error('A host kind\'s name "client" is reserved for hosts without an address');
	const fields = readParams(Object.entries(params ?? {}), `${name}.params`);
	const make = Object.defineProperty((values: Record<string, unknown> = {}) => ({ kind: name, params: values,
		key: addressKey(name, fields, values) }), "kind", { value: name, enumerable: true });
	declarations.set(make, fields);
	return make as unknown as HostKind<N, P>;
}
export function kindParams(kind: { readonly kind: string }): ParamsData {
	const found = declarations.get(kind);
	if (!found) throw new Error(`${kind.kind}: not a declared host kind`);
	return found;
}
export function addressKey(kind: string, params: ParamsData, values: Readonly<Record<string, unknown>>): string {
	return joinKey([kind, ...params.fields.map((field) => String(values[field]))]);
}
