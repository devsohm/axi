import { Type, type TSchema, type TString, type TNumber, type TInteger, type TBoolean, type TNull,
	type TLiteral, type TUnion, type TProperties, type TObject, type TArray, type TRecord, type TOptional,
	type TUnknown, type TUnsafe } from "typebox";
export type { Static, TSchema } from "typebox";
import type { HostKind, KindShape } from "./host-kind.ts";
import type { Params } from "./params.ts";

export type Bounds = { readonly min?: number; readonly max?: number };
export type Defaulted<T> = { readonly default: T };
type Defaults<T> = { readonly default?: T };
function bounds(options: Bounds, names: readonly [string, string]): Record<string, number> {
	return Object.fromEntries(names.flatMap((name, i) => {
		const value = i === 0 ? options.min : options.max;
		return value === undefined ? [] : [[name, value]];
	}));
}
const defaultValue = <T>(options: Defaults<T>) => options.default === undefined ? {} : { default: options.default };
export function str(options: Bounds & { readonly pattern?: string; readonly default: string }): TString & Defaulted<string>;
export function str(options?: Bounds & { readonly pattern?: string }): TString;
export function str(options: Bounds & { readonly pattern?: string } & Defaults<string> = {}): TString {
	return Type.String({ ...bounds(options, ["minLength", "maxLength"]),
		...(options.pattern === undefined ? {} : { pattern: options.pattern }), ...defaultValue(options) });
}
export function num(options: Bounds & { readonly default: number }): TNumber & Defaulted<number>;
export function num(options?: Bounds): TNumber;
export function num(options: Bounds & Defaults<number> = {}): TNumber {
	return Type.Number({ ...bounds(options, ["minimum", "maximum"]), ...defaultValue(options) });
}
export function int(options: Bounds & { readonly default: number }): TInteger & Defaulted<number>;
export function int(options?: Bounds): TInteger;
export function int(options: Bounds & Defaults<number> = {}): TInteger {
	return Type.Integer({ ...bounds(options, ["minimum", "maximum"]), ...defaultValue(options) });
}
export function bool(options: { readonly default: boolean }): TBoolean & Defaulted<boolean>;
export function bool(options?: Record<never, never>): TBoolean;
export function bool(options: Defaults<boolean> = {}): TBoolean { return Type.Boolean(defaultValue(options)); }
export function nul(): TNull { return Type.Null(); }
type Literal = string | number | boolean;
export function lit<const V extends Literal>(value: V): TLiteral<V> { return Type.Literal(value); }
type Literals<V extends Literal[]> = { [I in keyof V]: TLiteral<V[I]> };
export function oneOf<const V extends Literal[]>(...values: V): TUnion<Literals<V>> {
	return Type.Union(values.map((value) => Type.Literal(value))) as TUnion<Literals<V>>;
}
export function union<const S extends TSchema[]>(schemas: [...S]): TUnion<S> { return Type.Union(schemas); }
export function obj<P extends TProperties>(properties: P): TObject<P> { return Type.Object(properties, { additionalProperties: false }); }
export function arr<S extends TSchema>(items: S, options: Bounds = {}): TArray<S> {
	return Type.Array(items, bounds(options, ["minItems", "maxItems"]));
}
export function map<S extends TSchema>(value: S): TRecord<"^.*$", S> { return Type.Record(Type.String(), value); }
export function opt<S extends TSchema>(schema: S): TOptional<S> { return Type.Optional(schema) as TOptional<S>; }
export function unknown(): TUnknown { return Type.Unknown(); }
export type BytesMarker = { readonly type: "bytes"; readonly minLength?: number; readonly maxLength?: number };
export function bytes(options: Bounds = {}): TUnsafe<Uint8Array> {
	return { type: "bytes", ...bounds(options, ["minLength", "maxLength"]) } as unknown as TUnsafe<Uint8Array>;
}
export class Method<A extends TSchema = TSchema, R extends TSchema = TSchema> {
	readonly args: A;
	readonly result: R;
	constructor(args: A, result: R) { this.args = args; this.result = result; }
}
export class KeyedMember<S extends TSchema = TSchema, K extends KindShape | undefined = KindShape | undefined> {
	readonly schema: S;
	readonly key: K;
	constructor(schema: S, key: K) {
		this.schema = schema;
		this.key = key;
	}
}
export function keyed<S extends TSchema>(schema: S): KeyedMember<S, undefined>;
export function keyed<S extends TSchema, N extends string, P extends Params>(
	schema: S,
	key: HostKind<N, P>,
): KeyedMember<S, HostKind<N, P>>;
export function keyed(schema: TSchema, key?: KindShape): KeyedMember {
	return new KeyedMember(schema, key);
}
export function method(): Method<TNull, TNull>;
export function method<A extends TSchema>(args: A): Method<A, TNull>;
export function method<R extends TSchema>(args: undefined, result: R): Method<TNull, R>;
export function method<A extends TSchema, R extends TSchema>(args: A, result: R): Method<A, R>;
export function method(args?: TSchema, result?: TSchema): Method { return new Method(args ?? nul(), result ?? nul()); }
