import type { JsonValue } from "@axi/chord";

type JsonMap = Record<string, JsonValue>;
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
export function assignJson(container: JsonMap | JsonValue[], key: string | number, value: JsonValue): void {
	const current: unknown = Reflect.get(container, key);
	if (object(current) && object(value)) {
		for (const name of Object.keys(current)) if (!Object.hasOwn(value, name)) delete current[name];
		for (const name of Object.keys(value)) assignJson(current, name, value[name]!);
	} else if (Array.isArray(current) && Array.isArray(value) && current.length <= value.length) {
		for (let index = 0; index < value.length; index++) {
			if (index < current.length) assignJson(current, index, value[index]!);
			else current.push(value[index]!);
		}
	} else if (current !== value) Reflect.set(container, key, value);
}
