import type { JsonValue } from "../json.ts";
import type { Op, Path, Seg } from "./index.ts";

type Container = JsonValue[] | Record<string, JsonValue>;
const descriptor: PropertyDescriptor = { value: undefined, writable: true, configurable: true, enumerable: true };
const container = (value: unknown): value is Container => value !== null && typeof value === "object";
const read = (value: Container, key: Seg): JsonValue => (value as Record<Seg, JsonValue>)[key];
function put(target: Container, key: Seg, value: JsonValue): void {
	descriptor.value = value;
	Object.defineProperty(target, key, descriptor);
	descriptor.value = undefined;
}
function copy(value: Container): Container {
	if (Array.isArray(value)) return Array.from(value);
	const result: Record<string, JsonValue> = Object.create(
		Object.getPrototypeOf(value) === null ? null : Object.prototype,
	);
	for (const key of Object.keys(value)) put(result, key, value[key]);
	return result;
}
function branch(
	root: JsonValue,
	path: Path,
	depth: number,
	owned: WeakSet<object>,
): { root: JsonValue; target: Container } {
	if (!container(root)) throw new TypeError("Trusted operation root is not a container");
	let result = root;
	if (!owned.has(root)) {
		result = copy(root);
		owned.add(result);
	}
	let target = result;
	for (let offset = 0; offset < depth; offset++) {
		const key = path[offset],
			child = read(target, key);
		if (!container(child)) throw new TypeError("Trusted operation path is not a container");
		if (owned.has(child)) {
			target = child;
			continue;
		}
		const next = copy(child);
		put(target, key, next);
		owned.add(next);
		target = next;
	}
	return { root: result, target };
}
function splice(target: JsonValue[], start: number, remove: number, values: readonly JsonValue[]): void {
	const length = target.length,
		difference = values.length - remove;
	if (difference > 0) target.length = length + difference;
	if (difference !== 0) target.copyWithin(start + values.length, start + remove, length);
	if (difference < 0) target.length = length + difference;
	for (let index = 0; index < values.length; index++) put(target, start + index, values[index]);
}
export function applyImmutableTrusted<T>(value: T, operations: readonly Op[]): T {
	let root = value as JsonValue;
	const owned = new WeakSet<object>();
	for (const operation of operations) {
		if (operation[0] === "r") {
			root = operation[1];
			continue;
		}
		const [verb, path] = operation;
		const array = verb === "p" || verb === "m";
		const destination = branch(root, path, array ? path.length : path.length - 1, owned);
		root = destination.root;
		const target = destination.target;
		if (array) {
			if (!Array.isArray(target)) throw new TypeError("Trusted array operation target is not an array");
			if (verb === "p") splice(target, operation[2], operation[3], operation[4]);
			else {
				if (target.length !== operation[2].length) throw new TypeError("Trusted permutation length mismatch");
				const previous = target.slice();
				for (let index = 0; index < previous.length; index++) target[index] = previous[operation[2][index]];
			}
			continue;
		}
		const key = path[path.length - 1];
		switch (verb) {
			case "s":
				put(target, key, operation[2]);
				break;
			case "d":
				if (!Array.isArray(target)) Reflect.deleteProperty(target, key);
				else {
					if (typeof key !== "number") throw new TypeError("Trusted array deletion key is not numeric");
					splice(target, key, 1, []);
				}
				break;
			case "a":
			case "t": {
				const current = read(target, key);
				if (typeof current !== "string")
					throw new TypeError(`Trusted ${verb === "a" ? "append" : "truncate"} target is not a string`);
				put(target, key, verb === "a" ? current + operation[2] : current.slice(operation[2]));
				break;
			}
		}
	}
	return root as T;
}
