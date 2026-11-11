import {
	LOCAL,
	contractData,
	createContract,
	type Contract,
	type ContractShape,
	type CurrentVariants,
	type HostKeyed,
	type Kind,
	type MemberKind,
	type ShapeOf,
} from "./contract.ts";
import { checkMembers, keyedSnapshot, memberPath, readMethod } from "./declare.ts";
import type { HostKind, KindShape } from "./host-kind.ts";
import type { Params } from "./params.ts";
import { materialize } from "./fingerprint.ts";
import type { Change, CurrentStep, Increment, MemberNames, MethodAt, Variants, VariantsWith } from "./history.ts";
import { Method, type TSchema } from "./schema.ts";
import { snapshotArguments, snapshotSchema } from "./snapshot.ts";

type Put<V extends Variants, X, Side extends "state" | "methods", M extends string, T> = { [Y in keyof V]: Y extends X
	? { [S in keyof V[Y]]: S extends Side ? { [F in keyof V[Y][S] | M]: F extends M ? T : V[Y][S][F] } : V[Y][S] } : V[Y] };
type Drop<V extends Variants, X, Side extends "state" | "methods", M extends string> = { [Y in keyof V]: Y extends X
	? { [S in keyof V[Y]]: S extends Side ? Omit<V[Y][S], M> : V[Y][S] } : V[Y] };
type KeyedNames<V extends Variants> = keyof NonNullable<V[typeof LOCAL]["keyed"]> & string;
type PutKeyed<V extends Variants, M extends string, S extends TSchema> = {
	[X in keyof V]: X extends typeof LOCAL ? Omit<V[X], "keyed"> & {
		keyed: { [N in keyof NonNullable<V[X]["keyed"]> | M]: N extends M ? S : NonNullable<V[X]["keyed"]>[N & keyof NonNullable<V[X]["keyed"]>] };
	} : V[X];
};
type DropKeyed<V extends Variants, M extends string> = {
	[X in keyof V]: X extends typeof LOCAL ? Omit<V[X], "keyed"> & {
		keyed: Omit<NonNullable<V[X]["keyed"]>, M>;
	} : V[X];
};
interface Methods<K extends Kind, V extends Variants, C extends Change> {
	readonly "~variants"?: V;
	readonly "~changes"?: C;
	args<M extends MemberNames<V, "methods">, A extends TSchema>(member: M, args: A): Editor<K, Put<V, VariantsWith<V, M>, "methods", M, Method<A, MethodAt<V, M>["result"]>>, C | [VariantsWith<V, M>, M, "args"]>;
	result<M extends MemberNames<V, "methods">, R extends TSchema>(member: M, result: R): Editor<K, Put<V, VariantsWith<V, M>, "methods", M, Method<MethodAt<V, M>["args"], R>>, C | [VariantsWith<V, M>, M, "result"]>;
	method<M extends MemberNames<V, "methods">, A extends TSchema, R extends TSchema>(member: M, args: A, result: R): Editor<K, Put<V, VariantsWith<V, M>, "methods", M, Method<A, R>>, C | [VariantsWith<V, M>, M, "args" | "result"]>;
	removeMethod<M extends MemberNames<V, "methods">>(member: M): Editor<K, Drop<V, keyof V, "methods", M>, C>;
}
interface RemoteEditor<V extends Variants, C extends Change> extends Methods<"remote", V, C> {
	state<X extends keyof V & string, M extends keyof V[X]["state"] & string, S extends TSchema>(variant: X, member: M, schema: S): RemoteEditor<Put<V, X, "state", M, S>, C | [X, M, "state"]>;
	addState<X extends keyof V & string, const M extends string, S extends TSchema>(variant: X, member: M, schema: S): RemoteEditor<Put<V, X, "state", M, S>, C | [X, M, "state"]>;
	removeState<X extends keyof V & string, M extends keyof V[X]["state"] & string>(variant: X, member: M): RemoteEditor<Drop<V, X, "state", M>, C>;
	addMethod<X extends keyof V & string, const M extends string, A extends TSchema, R extends TSchema>(variant: X, member: M, args: A, result: R): RemoteEditor<Put<V, X, "methods", M, Method<A, R>>, C | [X, M, "args" | "result"]>;
}
interface LocalEditor<V extends Variants, C extends Change> extends Methods<"local", V, C> {
	state<M extends keyof V[typeof LOCAL]["state"] & string, S extends TSchema>(
		member: M,
		schema: S,
	): LocalEditor<Put<V, typeof LOCAL, "state", M, S>, C | [typeof LOCAL, M, "state"]>;
	addState<const M extends string, S extends TSchema>(
		member: M,
		schema: S,
	): LocalEditor<Put<V, typeof LOCAL, "state", M, S>, C | [typeof LOCAL, M, "state"]>;
	removeState<M extends keyof V[typeof LOCAL]["state"] & string>(
		member: M,
	): LocalEditor<Drop<V, typeof LOCAL, "state", M>, C>;
	addMethod<const M extends string, A extends TSchema, R extends TSchema>(
		member: M,
		args: A,
		result: R,
	): LocalEditor<Put<V, typeof LOCAL, "methods", M, Method<A, R>>, C | [typeof LOCAL, M, "args" | "result"]>;
	keyed<M extends KeyedNames<V>, S extends TSchema>(
		member: M,
		schema: S,
	): LocalEditor<PutKeyed<V, M, S>, C | [typeof LOCAL, M, "keyed"]>;
	keyed<M extends KeyedNames<V>, S extends TSchema, N extends string, P extends Params>(
		member: M,
		schema: S,
		key: HostKind<N, P>,
	): LocalEditor<PutKeyed<V, M, HostKeyed<S, HostKind<N, P>>>, C | [typeof LOCAL, M, "keyed"]>;
	addKeyed<const M extends string, S extends TSchema>(
		member: M,
		schema: S,
	): LocalEditor<PutKeyed<V, M, S>, C | [typeof LOCAL, M, "keyed"]>;
	addKeyed<const M extends string, S extends TSchema, N extends string, P extends Params>(
		member: M,
		schema: S,
		key: HostKind<N, P>,
	): LocalEditor<PutKeyed<V, M, HostKeyed<S, HostKind<N, P>>>, C | [typeof LOCAL, M, "keyed"]>;
	removeKeyed<M extends KeyedNames<V>>(member: M): LocalEditor<DropKeyed<V, M>, C>;
}
type Editor<K extends Kind, V extends Variants, C extends Change> = K extends "local" ? LocalEditor<V, C> : RemoteEditor<V, C>;
type Next<S extends ContractShape, E extends Methods<S["kind"], Variants, Change>> = {
	kind: S["kind"]; name: S["name"]; params: S["params"];
	history: [...S["history"], { version: Increment<CurrentStep<S["history"]>["version"]>;
		variants: NonNullable<E["~variants"]>; changes: NonNullable<E["~changes"]> }];
};
export function editWith<E>(editor: E, edit: (editor: E) => unknown, what: string): void {
	if (edit(editor) !== editor) throw new Error(`${what} must return the editor it was given`);
}
export function evolve<C extends Contract, E extends Methods<ShapeOf<C>["kind"], Variants, Change>>(
	previous: C, edit: (editor: Editor<ShapeOf<C>["kind"], CurrentVariants<C>, never>) => E,
): Contract<Next<ShapeOf<C>, E>> {
	const data = contractData(previous), latest = data.versions.at(-1)!, version = latest.version + 1;
	const path = `${data.name} v${version}`;
	const variants = new Map([...latest.variants].map(([name, value]) => [name,
		{ state: new Map(value.state), methods: new Map(value.methods), keyed: new Map(value.keyed) }]));
	const kinds = new Map(data.kinds), changes: Change[] = [];
	let editor: object;
	const at = (variant: string, member: string, kind: MemberKind) => memberPath(path, data.kind, variant, member, kind);
	const variantAt = (variant: string) => {
		const value = variants.get(variant);
		if (!value) throw new Error(`${path}.${variant}: unknown variant (the variant set never changes)`);
		return value;
	};
	const checked = () => { checkMembers(variants, kinds, at); return editor; };
	const ensureNew = (variant: string, member: string, kind: MemberKind) => {
		const value = variantAt(variant);
		if (value.state.has(member) || value.methods.has(member) || value.keyed.has(member)) throw new Error(`${at(variant, member, kind)}: already declared`);
	};
	const state = (adding: boolean, variant: string, member: string, schema: TSchema) => {
		const value = variantAt(variant);
		if (adding) ensureNew(variant, member, "state");
		else if (!value.state.has(member)) throw new Error(`${at(variant, member, "state")}: no such state member`);
		value.state.set(member, snapshotSchema(schema, at(variant, member, "state")));
		changes.push([variant, member, "state"]);
		return checked();
	};
	const removeState = (variant: string, member: string) => {
		if (!variantAt(variant).state.delete(member)) throw new Error(`${at(variant, member, "state")}: no such state member`);
		return editor;
	};
	const keyed = (adding: boolean, member: string, schema: TSchema, key?: KindShape) => {
		const value = variantAt(LOCAL);
		if (adding) ensureNew(LOCAL, member, "keyed");
		else if (!value.keyed.has(member)) throw new Error(`${at(LOCAL, member, "keyed")}: no such keyed member`);
		value.keyed.set(member, keyedSnapshot(schema, key, at(LOCAL, member, "keyed")));
		changes.push([LOCAL, member, "keyed"]);
		return checked();
	};
	const removeKeyed = (member: string) => {
		if (!variantAt(LOCAL).keyed.delete(member)) throw new Error(`${at(LOCAL, member, "keyed")}: no such keyed member`);
		return editor;
	};
	const methodVariants = (member: string) => {
		const names = [...variants.keys()].filter((name) => variants.get(name)!.methods.has(member));
		if (!names.length) throw new Error(`${path}: no method "${member}"`);
		return names;
	};
	const method = (member: string, args?: TSchema, result?: TSchema) => {
		const names = methodVariants(member), label = at(names[0]!, member, "method");
		const input = args === undefined ? undefined : snapshotArguments(args, `${label}.args`);
		const output = result === undefined ? undefined : snapshotSchema(result, `${label}.result`);
		for (const name of names) {
			const methods = variants.get(name)!.methods, old = methods.get(member)!;
			methods.set(member, { args: input ?? old.args, result: output ?? old.result });
			if (input !== undefined) changes.push([name, member, "args"]);
			if (output !== undefined) changes.push([name, member, "result"]);
		}
		return checked();
	};
	const addMethod = (variant: string, member: string, args: TSchema, result: TSchema) => {
		ensureNew(variant, member, "method");
		variantAt(variant).methods.set(member, readMethod(new Method(args, result), at(variant, member, "method")));
		changes.push([variant, member, "args"], [variant, member, "result"]);
		return checked();
	};
	const shared = {
		args: (name: string, input: TSchema) => method(name, input),
		result: (name: string, output: TSchema) => method(name, undefined, output),
		method,
		removeMethod: (member: string) => {
			for (const name of methodVariants(member)) variants.get(name)!.methods.delete(member);
			return editor;
		},
	};
	editor =
		data.kind === "local"
			? {
					...shared,
					state: (name: string, schema: TSchema) => state(false, LOCAL, name, schema),
					addState: (name: string, schema: TSchema) => state(true, LOCAL, name, schema),
					removeState: (name: string) => removeState(LOCAL, name),
					addMethod: (name: string, args: TSchema, result: TSchema) => addMethod(LOCAL, name, args, result),
					keyed: (name: string, schema: TSchema, key?: KindShape) => keyed(false, name, schema, key),
					addKeyed: (name: string, schema: TSchema, key?: KindShape) => keyed(true, name, schema, key),
					removeKeyed,
				}
			: {
					...shared,
					state: (variant: string, name: string, schema: TSchema) => state(false, variant, name, schema),
					addState: (variant: string, name: string, schema: TSchema) => state(true, variant, name, schema),
					removeState,
					addMethod,
				};
	editWith(editor as unknown as Editor<ShapeOf<C>["kind"], CurrentVariants<C>, never>, edit, `${path}: evolve`);
	return createContract({ ...data, kinds, versions: [...data.versions, materialize(data.kind, data.params, version, variants, changes)] });
}
