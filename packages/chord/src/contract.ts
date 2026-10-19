import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import { ChordError, invalid } from "./errors.ts";
import { canonicalJson, fits, hash64 } from "./schema.ts";
import type { Ctx, Exposed, Readable, RefBase, StateSource } from "./types.ts";

const MEMBER = Symbol("axi.member");
export interface MethodSpec<
	A extends TSchema | undefined = TSchema | undefined,
	R extends TSchema | undefined = TSchema | undefined,
> {
	readonly [MEMBER]: "method";
	readonly args: A;
	readonly result: R;
}
export interface OpaqueSpec<T = unknown> {
	readonly [MEMBER]: "opaque";
	readonly id: string;
	readonly type?: T;
}
export function method(): MethodSpec<undefined, undefined>;
export function method<A extends TSchema>(args: A): MethodSpec<A, undefined>;
export function method<A extends TSchema | undefined, R extends TSchema>(args: A, result: R): MethodSpec<A, R>;
export function method(args?: TSchema, result?: TSchema): MethodSpec {
	return { [MEMBER]: "method", args, result };
}
export function opaque<T = unknown>(id: string): OpaqueSpec<T> {
	if (!/^[^@\s]+@\d+$/.test(id)) throw new TypeError(`opaque id must be name@version: ${id}`);
	return { [MEMBER]: "opaque", id };
}
export interface VariantDef {
	readonly state?: Readonly<Record<string, TSchema>>;
	readonly methods?: Readonly<Record<string, MethodSpec>>;
}
export interface HostNamed {
	readonly name: string;
}
export interface HostFamily<K extends string = string> {
	readonly prefix: string;
	readonly key: K;
}
export type Placement = HostNamed | HostFamily;
type StringKeys<I> = { [K in keyof I]-?: I[K] extends string ? K : never }[keyof I] & string;
export type PlacementFor<I> = HostNamed | HostFamily<StringKeys<I>>;
export function hostNamed(name: string): HostNamed {
	if (typeof name !== "string" || !name) throw new TypeError("hostNamed needs a host name");
	return { name };
}
export function hostFamily<const K extends string>(prefix: string, key: K): HostFamily<K> {
	if (typeof prefix !== "string" || !prefix) throw new TypeError("hostFamily needs a host-name prefix");
	if (typeof key !== "string" || !key) throw new TypeError("hostFamily needs an input field name");
	return { prefix, key };
}
export function resolveHost(typeName: string, placement: Placement, input: unknown): string {
	if ("name" in placement) return placement.name;
	const value: unknown = input !== null && typeof input === "object" ? Reflect.get(input, placement.key) : undefined;
	if (typeof value !== "string" || !value)
		throw invalid("placement", `${typeName}: input field ${placement.key} names no host`);
	return placement.prefix + value;
}
export const placedOn = (placement: Placement, hostName: string): boolean =>
	"name" in placement
		? placement.name === hostName
		: hostName.startsWith(placement.prefix) && hostName.length > placement.prefix.length;
export const placementText = (placement: Placement): string =>
	"name" in placement ? placement.name : `${placement.prefix}<${placement.key}>`;
export interface RemoteDef {
	readonly version: number;
	readonly input: TSchema;
	readonly host: Placement;
	readonly variants: Readonly<Record<string, VariantDef>>;
}
export type LocalMember = MethodSpec | OpaqueSpec | TSchema;
export interface LocalDef {
	readonly version: number;
	readonly input: TSchema;
	readonly members?: Readonly<Record<string, LocalMember>>;
}
const SchemaObject = Type.Unsafe<TSchema>(Type.Object({}));
const MemberDescriptionSchema = Type.Union([
	Type.Object({ kind: Type.Literal("method"), args: Type.Optional(SchemaObject), result: Type.Optional(SchemaObject) }),
	Type.Object({ kind: Type.Literal("state"), schema: SchemaObject }),
	Type.Object({ kind: Type.Literal("opaque"), id: Type.String() }),
]);
export type MemberDescription = Static<typeof MemberDescriptionSchema>;
export const LOCAL_VARIANT = "";
const PlacementSchema = Type.Union([
	Type.Object({ name: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
	Type.Object(
		{ prefix: Type.String({ minLength: 1 }), key: Type.String({ minLength: 1 }) },
		{ additionalProperties: false },
	),
]);
export const DescriptionSchema = Type.Object({
	name: Type.String({ minLength: 1 }),
	scope: Type.Union([Type.Literal("remote"), Type.Literal("local")]),
	version: Type.Integer(),
	input: SchemaObject,
	host: Type.Optional(PlacementSchema),
	variants: Type.Record(Type.String(), Type.Record(Type.String(), MemberDescriptionSchema)),
});
export type Description = Static<typeof DescriptionSchema>;
interface ContractBase {
	readonly name: string;
	readonly version: number;
	readonly input: TSchema;
	readonly description: Description;
	readonly fingerprint: string;
}
export interface RemoteContract<D extends RemoteDef = RemoteDef> extends ContractBase {
	readonly scope: "remote";
	readonly def: D;
}
export interface LocalContract<D extends LocalDef = LocalDef> extends ContractBase {
	readonly scope: "local";
	readonly def: D;
}
export type AnyContract = RemoteContract | LocalContract;
export const RESERVED_MEMBERS: ReadonlySet<string> = new Set([
	"variant",
	"status",
	"ready",
	"shape",
	"error",
	"onShape",
	"onStatus",
	"release",
	"then",
	"contract",
]);

function describe(name: string, member: LocalMember, remote: boolean): MemberDescription {
	if (RESERVED_MEMBERS.has(name)) throw new TypeError(`member name is reserved: ${name}`);
	const brand = (member as { readonly [MEMBER]?: unknown })[MEMBER];
	if (brand === "opaque") {
		if (remote) throw new TypeError(`remote contracts cannot expose opaque members: ${name}`);
		return { kind: "opaque", id: (member as OpaqueSpec).id };
	}
	if (brand === "method") {
		const spec = member as MethodSpec;
		return {
			kind: "method",
			...(spec.args === undefined ? {} : { args: spec.args }),
			...(spec.result === undefined ? {} : { result: spec.result }),
		};
	}
	return { kind: "state", schema: member };
}
function header(name: string, version: number): void {
	if (!name) throw new TypeError("contract name is empty");
	if (!Number.isInteger(version) || version < 1) throw new TypeError("contract version must be a positive integer");
}
function token<C extends AnyContract>(contract: Omit<C, "fingerprint">): C {
	return { ...contract, fingerprint: hash64(canonicalJson(contract.description)) } as C;
}
export function remote<const D extends RemoteDef>(
	name: string,
	def: D & { readonly host: PlacementFor<Static<D["input"]>> },
): RemoteContract<D> {
	header(name, def.version);
	const placement = def.host;
	if (placement === undefined || !Value.Check(PlacementSchema, placement))
		throw new TypeError(`remote contract ${name} needs \`host\`: hostNamed(…) or hostFamily(…)`);
	const host: Placement =
		"name" in placement ? { name: placement.name } : { prefix: placement.prefix, key: placement.key };
	const variants: Description["variants"] = {};
	if (!Object.keys(def.variants).length) throw new TypeError(`remote contract ${name} has no variants`);
	for (const [variantName, variant] of Object.entries(def.variants)) {
		const members: Record<string, MemberDescription> = {};
		for (const [key, schema] of Object.entries(variant.state ?? {})) members[key] = describe(key, schema, true);
		for (const [key, spec] of Object.entries(variant.methods ?? {})) {
			if (key in members) throw new TypeError(`member ${key} is both state and method in ${name}.${variantName}`);
			members[key] = describe(key, spec, true);
			if (members[key].kind !== "method") throw new TypeError(`methods.${key} is not a method()`);
		}
		variants[variantName] = members;
	}
	const description: Description = { name, scope: "remote", version: def.version, input: def.input, host, variants };
	return token<RemoteContract<D>>({ scope: "remote", name, version: def.version, input: def.input, def, description });
}
export function local<const D extends LocalDef>(name: string, def: D): LocalContract<D> {
	header(name, def.version);
	const members: Record<string, MemberDescription> = {};
	for (const [key, member] of Object.entries(def.members ?? {})) members[key] = describe(key, member, false);
	const description: Description = {
		name,
		scope: "local",
		version: def.version,
		input: def.input,
		variants: { [LOCAL_VARIANT]: members },
	};
	return token<LocalContract<D>>({
		scope: "local",
		name,
		version: def.version,
		input: def.input,
		def,
		description,
	});
}
export function contractFromDescription(description: Description): AnyContract {
	const { name, scope, version, input, host } = description;
	if (
		typeof name !== "string" ||
		(scope !== "remote" && scope !== "local") ||
		!Number.isInteger(version) ||
		(scope === "remote") !== (host !== undefined)
	)
		throw new ChordError("invalid", "malformed contract token", { reason: "token" });
	const base = { name, version, input, description, fingerprint: hash64(canonicalJson(description)) };
	return scope === "remote"
		? { ...base, scope, def: { version, input, host: host!, variants: {} } }
		: { ...base, scope, def: { version, input } };
}
const samePlacement = (a: Description, b: Description): boolean =>
	canonicalJson(a.host ?? null) === canonicalJson(b.host ?? null);
const placementLabel = (description: Description): string =>
	description.host === undefined ? "(local)" : placementText(description.host);
export function coverage(provider: Description, consumer: Description): string | undefined {
	if (provider.name !== consumer.name || provider.scope !== consumer.scope) return "different type";
	if (!samePlacement(provider, consumer)) return "host";
	if (!fits(consumer.input, provider.input)) return "input";
	for (const [variant, members] of Object.entries(consumer.variants)) {
		const offered = provider.variants[variant];
		if (offered === undefined) return `variant ${variant} missing`;
		for (const [name, wanted] of Object.entries(members)) {
			const actual = offered[name],
				label = `${variant}.${name}`;
			if (!actual || actual.kind !== wanted.kind) return `${label} missing or of another kind`;
			if (actual.kind === "state" && wanted.kind === "state" && !fits(actual.schema, wanted.schema))
				return `${label} state`;
			if (actual.kind === "opaque" && wanted.kind === "opaque" && actual.id !== wanted.id)
				return `${label} opaque ${actual.id} != ${wanted.id}`;
			if (actual.kind !== "method" || wanted.kind !== "method") continue;
			if (
				(actual.args === undefined) !== (wanted.args === undefined) ||
				(wanted.args !== undefined && actual.args !== undefined && !fits(wanted.args, actual.args))
			)
				return `${label} arguments`;
			if (wanted.result !== undefined && (actual.result === undefined || !fits(actual.result, wanted.result)))
				return `${label} result`;
		}
	}
	return undefined;
}
export type Adapter = (current: Record<string, unknown>) => Record<string, unknown>;
export type Accepts = Readonly<Record<number, Adapter>>;
export function bind(provider: AnyContract, accepts: Accepts | undefined, consumer: AnyContract): Adapter | undefined {
	if (provider.fingerprint === consumer.fingerprint) return undefined;
	if (!samePlacement(provider.description, consumer.description)) {
		throw new ChordError(
			"contract_mismatch",
			`${provider.name} lives on ${placementLabel(provider.description)}, the consumer expects ${placementLabel(consumer.description)}`,
		);
	}
	if (provider.version === consumer.version) {
		const reason = coverage(provider.description, consumer.description);
		if (!reason) return undefined;
		throw new ChordError(
			"contract_mismatch",
			`${provider.name}@${provider.version} does not cover the consumer's description (${reason}); forgotten version bump?`,
		);
	}
	const adapter = accepts?.[consumer.version];
	if (adapter === undefined)
		throw new ChordError(
			"contract_mismatch",
			`${provider.name}: provider version ${provider.version}, consumer version ${consumer.version}, no accepts adapter`,
		);
	return adapter;
}
export function takesNoArgs(contract: AnyContract, name: string): boolean {
	for (const members of Object.values(contract.description.variants)) {
		const member = members[name];
		if (member?.kind === "method") return member.args === undefined;
	}
	return false;
}

type Empty = Record<never, never>;
type StateOf<V> = V extends { readonly state: infer S extends Readonly<Record<string, TSchema>> } ? S : Empty;
type MethodsOf<V> = V extends { readonly methods: infer M extends Readonly<Record<string, MethodSpec>> } ? M : Empty;
type StateValue<S> = S extends TSchema ? Static<S> : never;
type Result<R> = [R] extends [TSchema] ? Static<R> : undefined;
type Returned<R> = [R] extends [TSchema] ? Static<R> | Promise<Static<R>> : void | Promise<void>;
export type MethodImplementation<M, P = unknown> = M extends MethodSpec<infer A, infer R>
	? [A] extends [TSchema]
		? (args: Static<A>, ctx: Ctx<P>) => Returned<R>
		: (ctx: Ctx<P>) => Returned<R>
	: never;
export type Call<M> = M extends MethodSpec<infer A, infer R>
	? [A] extends [TSchema]
		? (args: Static<A>, ctx?: Ctx) => Promise<Result<R>>
		: (ctx?: Ctx) => Promise<Result<R>>
	: never;
type VariantImplementation<K, V, P> = { readonly variant: K } & {
	readonly [S in keyof StateOf<V>]: StateSource<StateValue<StateOf<V>[S]>>;
} & { readonly [M in keyof MethodsOf<V>]: MethodImplementation<MethodsOf<V>[M], P> };
type VariantRef<C extends AnyContract, K, V> = RefBase<C> & { readonly variant: K } & {
	readonly [S in keyof StateOf<V>]: Readable<StateValue<StateOf<V>[S]>>;
} & { readonly [M in keyof MethodsOf<V>]: Call<MethodsOf<V>[M]> };
type LocalMembers<D> = D extends { readonly members: infer M extends Readonly<Record<string, LocalMember>> }
	? M
	: Empty;
type ImplementationMember<M, P> = M extends MethodSpec
	? MethodImplementation<M, P>
	: M extends OpaqueSpec<infer T>
		? T | Exposed<T>
		: M extends TSchema
			? StateSource<Static<M>>
			: never;
type ReferenceMember<M> = M extends MethodSpec
	? Call<M>
	: M extends OpaqueSpec<infer T>
		? T | undefined
		: M extends TSchema
			? Readable<Static<M>>
			: never;
export type InputOf<C> = C extends { readonly def: { readonly input: infer I extends TSchema } } ? Static<I> : never;
export type ImplementationOf<C, P = unknown> = C extends RemoteContract<infer D>
	? { [K in keyof D["variants"]]: VariantImplementation<K, D["variants"][K], P> }[keyof D["variants"]]
	: C extends LocalContract<infer D>
		? { readonly [K in keyof LocalMembers<D>]: ImplementationMember<LocalMembers<D>[K], P> } & Record<string, unknown>
		: never;
export type Ref<C extends AnyContract = AnyContract> = C extends RemoteContract<infer D>
	? { [K in keyof D["variants"]]: VariantRef<C, K, D["variants"][K]> }[keyof D["variants"]]
	: C extends LocalContract<infer D>
		? RefBase<C> & { readonly [K in keyof LocalMembers<D>]: ReferenceMember<LocalMembers<D>[K]> }
		: never;
