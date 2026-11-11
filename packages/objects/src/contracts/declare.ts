import {
	createContract,
	LOCAL,
	type Contract,
	type HostAddress,
	type HostKeyed,
	type KeyedSnapshot,
	type Kind,
	type MemberKind,
	type MethodData,
	type VariantData,
} from "./contract.ts";
import { materialize } from "./fingerprint.ts";
import type { MemberNames, MethodAt, VariantShape } from "./history.ts";
import { type Address, type KindShape, kindParams } from "./host-kind.ts";
import { checkName } from "./names.ts";
import { readParams, type Params, type RequiredFields } from "./params.ts";
import { KeyedMember, Method, type Static, type TSchema } from "./schema.ts";
import { snapshotArguments, snapshotSchema, type Snapshot } from "./snapshot.ts";

type Declaration = { readonly state?: Readonly<Record<string, TSchema>>; readonly methods?: Readonly<Record<string, Method>> };
type Remote<D extends Readonly<Record<string, Declaration>>> = { [N in keyof D]: {
	state: D[N]["state"] extends object ? D[N]["state"] : Record<never, never>;
	methods: D[N]["methods"] extends object ? D[N]["methods"] : Record<never, never>;
} };
type LocalMember = TSchema | Method | KeyedMember;
type Local<M extends Readonly<Record<string, LocalMember>>> = {
	[LOCAL]: {
		state: { [N in keyof M as M[N] extends Method | KeyedMember ? never : N]: Exclude<M[N], Method | KeyedMember> };
		methods: { [N in keyof M as M[N] extends Method ? N : never]: Extract<M[N], Method> };
		keyed: {
			[N in keyof M as M[N] extends KeyedMember ? N : never]: M[N] extends KeyedMember<infer S, infer K>
				? K extends KindShape
					? HostKeyed<S, K>
					: S
				: never;
		};
	};
};
type Consistent<D extends Readonly<Record<string, Declaration>>, V extends Record<string, VariantShape> = Remote<D>> = {
	[N in keyof D]: {
		state?: {
			[M in keyof D[N]["state"]]: M extends MemberNames<V, "methods">
				? never
				: D[N]["state"][M] extends KeyedMember
					? never
					: D[N]["state"][M];
		};
		methods?: {
			[M in keyof D[N]["methods"]]: M extends MemberNames<V, "state">
				? never
				: [MethodAt<V, M>] extends [D[N]["methods"][M]]
					? D[N]["methods"][M]
					: never;
		};
	};
};
export function remote<
	const N extends string,
	const P extends Params,
	const V extends number,
	const D extends Readonly<Record<string, Declaration>>,
>(
	name: N,
	declaration: {
		readonly version: V;
		readonly params: P & NoInfer<RequiredFields<P>>;
		readonly hostAddress: (params: { [F in keyof P]: Static<P[F]> }) => Address;
		readonly variants: D & NoInfer<Consistent<D>>;
	},
): Contract<{
	kind: "remote";
	name: N;
	params: P;
	history: [{ version: `${V}`; variants: Remote<D>; changes: never }];
}> {
	checkName(name, "A contract name");
	checkKeys(declaration, ["version", "params", "hostAddress", "variants"], name);
	const variants = entriesOf(declaration.variants, `${name}.variants`);
	if (!variants.length) throw new Error(`${name}.variants: at least one variant is required`);
	if (typeof declaration.hostAddress !== "function") throw new Error(`${name}.hostAddress: expected a function of the params`);
	const read = new Map(variants.map(([variant, value]) => {
		const path = `${name}.${variant}`;
		checkKeys(value, ["state", "methods"], path);
		const { state = {}, methods = {} } = value as Declaration;
		const stateData = new Map(entriesOf(state, `${path}.state`).map(([member, schema]) => {
			if (schema instanceof Method) throw new Error(`${path}.state.${member}: a method belongs in methods`);
			if (schema instanceof KeyedMember) throw new Error(`${path}.state.${member}: keyed members are only in local contracts`);
			return [member, snapshotSchema(schema, `${path}.state.${member}`)];
		}));
		const methodData = new Map(entriesOf(methods, `${path}.methods`).map(([member, method]) => {
			if (!(method instanceof Method)) throw new Error(`${path}.methods.${member}: expected method(...)`);
			return [member, readMethod(method, `${path}.methods.${member}`)];
		}));
		return [variant, { state: stateData, methods: methodData, keyed: new Map<string, Snapshot>() }];
	}));
	return declare("remote", name, declaration, read, declaration.hostAddress as HostAddress);
}
export function local<const N extends string, const P extends Params, const V extends number, const M extends Readonly<Record<string, LocalMember>>>(
	name: N, declaration: { readonly version: V; readonly params: P & NoInfer<RequiredFields<P>>; readonly members: M },
): Contract<{ kind: "local"; name: N; params: P; history: [{ version: `${V}`; variants: Local<M>; changes: never }] }> {
	checkName(name, "A contract name");
	checkKeys(declaration, ["version", "params", "members"], name);
	const variant: { state: Map<string, Snapshot>; methods: Map<string, MethodData>; keyed: Map<string, KeyedSnapshot> } =
		{ state: new Map(), methods: new Map(), keyed: new Map() };
	for (const [name_, member] of entriesOf(declaration.members, `${name}.${LOCAL}`)) {
		const path = `${name}.${LOCAL}.${name_}`;
		if (member instanceof Method) variant.methods.set(name_, readMethod(member, path));
		else if (member instanceof KeyedMember) variant.keyed.set(name_, keyedSnapshot(member.schema, member.key, path));
		else variant.state.set(name_, snapshotSchema(member, path));
	}
	return declare("local", name, declaration, new Map([[LOCAL, variant]]));
}
function declare<C extends Contract>(kind: Kind, name: string, declaration: { readonly version: number; readonly params: unknown }, variants: ReadonlyMap<string, VariantData>, hostAddress?: HostAddress): C {
	if (!Number.isSafeInteger(declaration.version) || declaration.version < 1) throw new Error(`${name}.version: expected a positive integer`);
	const kinds = new Map<string, MemberKind>();
	checkMembers(variants, kinds, (variant, member, type) => memberPath(name, kind, variant, member, type));
	const params = readParams(entriesOf(declaration.params, `${name}.params`), `${name}.params`);
	return createContract({ kind, name, params, hostAddress, kinds, versions: [materialize(kind, params, declaration.version, variants, [])] });
}
export function keyedSnapshot(schema: unknown, key: KindShape | undefined, path: string): KeyedSnapshot {
	const snapshot = snapshotSchema(schema, path);
	if (key === undefined) return snapshot;
	kindParams(key);
	return { ...snapshot, key };
}
export function readMethod(method: Method, path: string): MethodData {
	return { args: snapshotArguments(method.args, `${path}.args`), result: snapshotSchema(method.result, `${path}.result`) };
}
export function checkMembers(variants: ReadonlyMap<string, VariantData>, kinds: Map<string, MemberKind>, path: (variant: string, member: string, kind: MemberKind) => string): void {
	const signatures = new Map<string, string>();
	for (const [variant, data] of variants) {
		for (const type of ["state", "keyed", "method"] as const) {
			for (const member of (type === "method" ? data.methods : data[type]).keys()) {
				const label = path(variant, member, type);
				if (["then", "release", "variant", "state", "retry"].includes(member)) throw new Error(`${label}: "${member}" is reserved: a reference has it`);
				const previous = kinds.get(member);
				if (previous !== undefined && previous !== type) throw new Error(`${label}: "${member}" is a ${previous} member; its kind never changes`);
				kinds.set(member, type);
				if (type === "method") {
					const method = data.methods.get(member)!;
					const signature = JSON.stringify([method.args.normal, method.result.normal]);
					if (signatures.has(member) && signatures.get(member) !== signature) throw new Error(`${label}: a method has the same signature in every variant`);
					signatures.set(member, signature);
				}
			}
		}
	}
}
export function memberPath(base: string, kind: Kind, variant: string, member: string, memberKind: MemberKind): string {
	return kind === "local" ? `${base}.${LOCAL}.${member}` : `${base}.${variant}.${memberKind === "state" ? "state" : "methods"}.${member}`;
}
export function checkKeys(source: unknown, allowed: readonly string[], path: string): void {
	for (const [key] of entriesOf(source, path)) if (!allowed.includes(key)) throw new Error(`${path}: unknown key "${key}"`);
}
export function entriesOf(source: unknown, path: string): [string, unknown][] {
	if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error(`${path}: expected an object`);
	return Object.entries(source);
}
