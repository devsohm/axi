import type { Context } from "../context/index.ts";
import { checkAccepts, type AcceptedVersion, type AcceptsTable } from "../contracts/accepts.ts";
import { contractData, type Contract, type CurrentVariants } from "../contracts/contract.ts";
import type { MemberNames, MethodAt } from "../contracts/history.ts";
import type { Static } from "../contracts/schema.ts";
import type { Snapshot } from "../contracts/snapshot.ts";
import { invalid, ObjectsError } from "./errors.ts";
import { check, validatorFor, type Validator } from "./validator.ts";

export type Value = null | boolean | number | string | Uint8Array | Value[] | { [key: string]: Value };
export type Provider<C extends Contract> = {
	readonly contract: C;
	readonly accepted: readonly AcceptedVersion[];
	readonly accepts: AcceptsTable<C>;
};
type CurrentArgs<C extends Contract, M> = M extends MemberNames<CurrentVariants<C>, "methods"> ? Static<MethodAt<CurrentVariants<C>, M>["args"]> : Value;
export type CheckedArgs<C extends Contract, M extends string> =
	{ readonly kind: "method"; readonly args: CurrentArgs<C, M>; readonly result?: (current: Value) => Value }
	| { readonly kind: "call"; readonly args: Value; readonly call: (args: Value, context: Context) => Promise<Value> };
type Mapping = "refuse" | { readonly call: (args: Value, context: Context) => Promise<Value> }
	| { readonly args?: (old: Value) => Value; readonly result?: (current: Value) => Value };
type Entry = { readonly kind: "refuse" } | { readonly kind: "call"; readonly schema: Snapshot; validator?: Validator;
	readonly call: (args: Value, context: Context) => Promise<Value> }
	| { readonly kind: "method"; readonly schema: Snapshot; validator?: Validator;
		readonly args: ((old: Value) => Value) | undefined; readonly result: ((current: Value) => Value) | undefined };
const dispatches = new WeakMap<Provider<Contract>, Map<number, Map<string, Entry>>>();
export function bindProvider<C extends Contract>(contract: C, accepts: AcceptsTable<C>): Provider<C> {
	const { versions: accepted } = checkAccepts(contract, accepts), history = contractData(contract).versions;
	const tables = new Map<number, Map<string, Entry>>();
	const mappings = accepts as Record<string, { readonly methods?: Record<string, Mapping> }>;
	for (const version of [history.at(-1)!, ...accepted.map((item) => history.find((value) => value.version === item.version)!)]) {
		const methods = new Map<string, Entry>();
		for (const variant of version.variants.values()) {
			for (const [member, method] of variant.methods) {
				const provided = version === history.at(-1) ? undefined : mappings[version.version]?.methods;
				const mapping = provided && Object.hasOwn(provided, member) ? provided[member] : undefined;
				methods.set(member, mapping === "refuse" ? { kind: "refuse" }
					: mapping && "call" in mapping ? { kind: "call", schema: method.args, call: mapping.call }
					: { kind: "method", schema: method.args, args: mapping?.args, result: mapping?.result });
			}
		}
		tables.set(version.version, methods);
	}
	const provider = { contract, accepted, accepts };
	dispatches.set(provider, tables);
	return provider;
}
export function binds(provider: Provider<Contract>, version: number, fingerprint: string): boolean {
	return version === provider.contract.version
		? fingerprint === provider.contract.fingerprint
		: provider.accepted.some((entry) => entry.version === version && entry.fingerprint === fingerprint);
}
export function checkArgs<C extends Contract, M extends string>(provider: Provider<C>, method: M, raw: unknown, boundVersion: number, context: Context): CheckedArgs<C, M> {
	const label = `${provider.contract.name} v${boundVersion}`, methods = dispatches.get(provider)!.get(boundVersion);
	if (!methods) throw new ObjectsError({ code: "contract_mismatch", message: `${label} is not accepted` });
	const entry = methods.get(method);
	if (!entry) throw invalid("member", `${label} has no method "${method}"`);
	if (entry.kind === "refuse") throw new ObjectsError({ code: "contract_mismatch", message: `${label} refuses "${method}"` });
	entry.validator ??= validatorFor(entry.schema, context);
	check(entry.validator, raw, "args", context);
	const value = raw as Value;
	return entry.kind === "call" ? { kind: "call", args: value, call: entry.call }
		: { kind: "method", args: (entry.args === undefined ? value : entry.args(value)) as CurrentArgs<C, M>, result: entry.result };
}
