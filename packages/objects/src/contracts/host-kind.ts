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
type KeyField = {
	readonly name: string;
	readonly type: "string" | "integer" | "boolean";
	readonly choices?: ReadonlySet<string>;
};
type Declaration = { readonly params: ParamsData; readonly fields: readonly KeyField[] };
const declarations = new WeakMap<object, Declaration>();
export function hostKind<const N extends string, const P extends Params = Record<never, never>>(name: N, params?: P & NoInfer<RequiredFields<P>>): HostKind<N, P> {
	checkName(name, "A host kind's name");
	if (name === "client") throw new Error('A host kind\'s name "client" is reserved for hosts without an address');
	const fields = readParams(Object.entries(params ?? {}), `${name}.params`);
	const make = Object.defineProperty((values: Record<string, unknown> = {}) => ({ kind: name, params: values,
		key: addressKey(name, fields, values) }), "kind", { value: name, enumerable: true });
	// readParams has already admitted only these field normal forms.
	const forms = fields.normal as unknown as readonly (readonly [
		string,
		{ readonly type?: KeyField["type"]; readonly anyOf?: readonly { readonly const: string }[] },
	])[];
	const keyFields = forms.map(
		([name, schema]): KeyField => ({
			name,
			type: schema.type ?? "string",
			...(schema.anyOf === undefined ? {} : { choices: new Set(schema.anyOf.map((branch) => branch.const)) }),
		}),
	);
	declarations.set(make, { params: fields, fields: keyFields });
	return make as unknown as HostKind<N, P>;
}
export function kindParams(kind: { readonly kind: string }): ParamsData {
	return declaration(kind).params;
}
function declaration(kind: { readonly kind: string }): Declaration {
	const found = declarations.get(kind);
	if (!found) throw new Error(`${kind.kind}: not a declared host kind`);
	return found;
}
export function keyOfAddress(kind: { readonly kind: string }, value: unknown): string | undefined {
	if (value === null || typeof value !== "object") return;
	const address = value as { readonly kind?: unknown; readonly params?: unknown };
	if (address.kind !== kind.kind || address.params === null || typeof address.params !== "object") return;
	const data = declaration(kind),
		values = address.params as Readonly<Record<string, unknown>>;
	if (Object.keys(values).length !== data.fields.length) return;
	for (const field of data.fields) {
		const item = values[field.name];
		const fits =
			field.type === "integer"
				? Number.isSafeInteger(item)
				: field.type === "boolean"
					? typeof item === "boolean"
					: typeof item === "string" && (field.choices === undefined || field.choices.has(item));
		if (!fits) return;
	}
	// A caller's key can be forged; identity comes from the declared parameter order.
	return addressKey(kind.kind, data.params, values);
}
export function addressOfKey<K extends KindShape>(kind: K, key: string): Address<K> {
	const data = declaration(kind),
		parts = [""];
	let escaped = false;
	for (const character of key) {
		if (escaped) {
			parts[parts.length - 1] += character;
			escaped = false;
		} else if (character === "\\") escaped = true;
		else if (character === "|") parts.push("");
		else parts[parts.length - 1] += character;
	}
	if (parts[0] !== kind.kind || parts.length !== data.fields.length + 1)
		throw new Error(`${JSON.stringify(key)}: not an address key of ${kind.kind}`);
	const values: Record<string, string | number | boolean> = {};
	for (const [index, field] of data.fields.entries()) {
		const text = parts[index + 1]!;
		values[field.name] = field.type === "integer" ? Number(text) : field.type === "boolean" ? text === "true" : text;
	}
	return { kind: kind.kind, params: values as ParamsOfKind<K>, key };
}
export function kindOfKey(key: string): string {
	const separator = key.indexOf("|");
	return separator < 0 ? key : key.slice(0, separator);
}
export function addressKey(kind: string, params: ParamsData, values: Readonly<Record<string, unknown>>): string {
	return joinKey([kind, ...params.fields.map((field) => String(values[field]))]);
}
