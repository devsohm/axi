import { objectsMetrics } from "../telemetry.ts";
import type { Context } from "../context/index.ts";
import type { JsonValue } from "../json.ts";

export type Principal = { readonly kind: string; readonly [field: string]: JsonValue };
export type PrincipalKeyFunction<P extends Principal = Principal> = (principal: P) => string;
const keys = new WeakMap<Principal, WeakMap<object, string>>();
const defaultKey = {};
const serialized = new WeakMap<Principal, string>();
export function principalJson(principal: Principal, context: Context): string {
	const cached = serialized.get(principal);
	if (cached !== undefined) return cached;
	objectsMetrics(context.telemetry.metrics).counter("objects.data.walks").add(1);
	const value = JSON.stringify(principal);
	serialized.set(principal, value);
	return value;
}
export function principalKey<P extends Principal>(principal: P, context: Context, customKey?: PrincipalKeyFunction<P>): string {
	let cached = keys.get(principal);
	if (!cached) keys.set(principal, cached = new WeakMap());
	const identity = customKey ?? defaultKey;
	let key = cached.get(identity);
	if (key === undefined) {
		key = customKey ? customKey(principal) : canonicalJson(principal, context);
		cached.set(identity, key);
	}
	return key;
}
export function samePrincipal(principal: Principal | undefined, other: Principal, context: Context): boolean {
	if (principal === undefined) return false;
	return principalKey(principal, context) === principalKey(other, context);
}
export function canonicalJson(value: JsonValue, context: Context): string {
	objectsMetrics(context.telemetry.metrics).counter("objects.data.walks").add(1);
	type Work = { value: JsonValue } | { text: string };
	const stack: Work[] = [{ value }], output: string[] = [];
	while (stack.length) {
		const item = stack.pop()!;
		if ("text" in item) { output.push(item.text); continue; }
		const current = item.value;
		if (current === null || typeof current !== "object") { output.push(JSON.stringify(current)); continue; }
		const array = Array.isArray(current);
		output.push(array ? "[" : "{");
		stack.push({ text: array ? "]" : "}" });
		const fields = array ? Array.from({ length: current.length }, (_, i) => String(i)) : Object.keys(current).sort();
		for (let i = fields.length - 1; i >= 0; i--) {
			const key = fields[i]!;
			if (i < fields.length - 1) stack.push({ text: "," });
			stack.push({ value: array ? current[Number(key)]! : current[key]! });
			if (!array) stack.push({ text: `${JSON.stringify(key)}:` });
		}
	}
	return output.join("");
}
