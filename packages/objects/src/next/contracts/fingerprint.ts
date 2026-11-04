import type { JsonValue } from "../../json.ts";
import { LOCAL, type Kind, type VariantData, type VersionData } from "./contract.ts";
import type { Change } from "./history.ts";
import type { ParamsData } from "./params.ts";

export const NORMAL_FORM_VERSION = 2;
export function hash64(text: string): string {
	let first = 2166136261, second = 3421674724;
	for (const byte of new TextEncoder().encode(text)) {
		first = Math.imul(first ^ byte, 16777619);
		second = Math.imul(second ^ byte, 16777623);
	}
	return [second, first].map((value) => (value >>> 0).toString(16).padStart(8, "0")).join("");
}
export function fingerprintOf(normal: JsonValue): string {
	return hash64(JSON.stringify({ normalFormVersion: NORMAL_FORM_VERSION, value: normal }));
}
function members(variant: VariantData): JsonValue {
	const entries: [string, JsonValue][] = [];
	for (const [name, state] of variant.state) entries.push([name, { state: state.normal }]);
	for (const [name, keyed] of variant.keyed) entries.push([name, { keyed: keyed.normal }]);
	for (const [name, method] of variant.methods) entries.push([name, { args: method.args.normal, result: method.result.normal }]);
	return Object.fromEntries(entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}
export function materialize(kind: Kind, params: ParamsData, version: number, variants: ReadonlyMap<string, VariantData>, changes: readonly Change[]): VersionData {
	const normal: JsonValue = kind === "local" ? { kind, params: params.normal, members: members(variants.get(LOCAL)!) }
		: { kind, params: params.normal, variants: Object.fromEntries([...variants.keys()].sort().map((name) => [name, members(variants.get(name)!)])) };
	return { version, fingerprint: fingerprintOf(normal), variants, changes };
}
