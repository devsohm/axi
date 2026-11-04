import type { JsonValue } from "@axi/objects/json";
import { appendText, type Draft } from "@axi/objects/delta";

type JsonMap = Record<string, JsonValue>;
export type AssignPlan =
	| { readonly kind: "keep" }
	| { readonly kind: "append"; readonly text: string }
	| { readonly kind: "fields"; readonly fields: ReadonlyMap<string | number, AssignPlan> };
export function jsonEqual(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
	if (Array.isArray(left) || Array.isArray(right))
		return (
			Array.isArray(left) &&
			Array.isArray(right) &&
			left.length === right.length &&
			left.every((value, index) => jsonEqual(value, right[index]))
		);
	const keys = Object.keys(left);
	return (
		keys.length === Object.keys(right).length &&
		keys.every((key) => Object.hasOwn(right, key) && jsonEqual(Reflect.get(left, key), Reflect.get(right, key)))
	);
}
function object(value: unknown): value is JsonMap {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function assignJson<T extends object, K extends keyof T & (string | number)>(
	container: T,
	key: K,
	value: T[K] & JsonValue,
	plan?: AssignPlan,
): void {
	if (plan?.kind === "keep") return;
	const current: unknown =
		key === "__proto__" && !Object.hasOwn(container, key) ? undefined : Reflect.get(container, key);
	const children = plan?.kind === "fields" ? plan.fields : undefined;
	if (object(current) && object(value)) {
		for (const name of Object.keys(current)) if (!Object.hasOwn(value, name)) delete current[name];
		for (const name of Object.keys(value)) assignJson(current, name, value[name]!, children?.get(name));
	} else if (Array.isArray(current) && Array.isArray(value) && current.length <= value.length) {
		for (let index = 0; index < value.length; index++) {
			if (index < current.length) assignJson(current, index, value[index]!, children?.get(index));
			else current.push(value[index]!);
		}
	} else if (
		plan?.kind === "append" &&
		typeof current === "string" &&
		typeof value === "string" &&
		!Array.isArray(container) &&
		value.length === current.length + plan.text.length
	) {
		// The selected slot is a string; appendText accesses only that slot.
		appendText(container as Draft<Record<string, string>>, String(key), plan.text);
	} else if (current !== value) Reflect.set(container, key, value);
}
