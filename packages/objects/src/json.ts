export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type JsonRepresentation<T> = unknown extends T
	? JsonValue
	: T extends null | boolean | number | string
		? T
		: T extends readonly (infer Item)[]
			? JsonRepresentation<Item>[]
			: T extends object
				? { [Key in keyof T]: JsonRepresentation<T[Key]> }
				: never;

export type CopyJsonOptions = { readonly omitUndefinedProperties?: boolean };
const descriptor: PropertyDescriptor = { value: undefined, enumerable: true, writable: true, configurable: true };

export function copyJson(value: unknown, options?: CopyJsonOptions): JsonValue {
	return copy(value, undefined, options?.omitUndefinedProperties === true);
}

export function isJsonValue(value: unknown): value is JsonValue {
	return check(value, new Set());
}

function define(target: object, key: PropertyKey, value: JsonValue): void {
	descriptor.value = value;
	Object.defineProperty(target, key, descriptor);
	descriptor.value = undefined;
}

function copy(value: unknown, parents: Set<object> | undefined, omitUndefined: boolean): JsonValue {
	if (value === null || typeof value === "boolean" || typeof value === "string") return value;
	if (typeof value === "number") {
		if (Number.isFinite(value)) return value;
		throw new TypeError("Value contains a non-finite number and is not strict JSON");
	}
	if (typeof value !== "object") {
		throw new TypeError(`Value contains a non-JSON ${typeof value}; expected strict JSON`);
	}
	parents ??= new Set();
	if (parents.has(value)) throw new TypeError("Value contains cycles and is not strict JSON");
	parents.add(value);
	try {
		if (Array.isArray(value)) {
			if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) {
				throw new TypeError("Value must contain strict JSON dense plain arrays");
			}
			const result = new Array<JsonValue>(value.length);
			for (let i = 0; i < value.length; i++) {
				const property = Object.getOwnPropertyDescriptor(value, i);
				if (property === undefined || !property.enumerable || !("value" in property)) {
					throw new TypeError("Value must contain strict JSON enumerable indexed data properties");
				}
				define(result, String(i), copy(property.value, parents, omitUndefined));
			}
			return result;
		}
		const prototype: object | null = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new TypeError("Value must contain strict JSON plain objects or arrays");
		}
		const result: Record<string, JsonValue> = Object.create(prototype);
		for (const key of Reflect.ownKeys(value)) {
			if (typeof key === "symbol") throw new TypeError("Value contains a symbol key and is not strict JSON");
			const property = Object.getOwnPropertyDescriptor(value, key)!;
			if (!property.enumerable || !("value" in property)) {
				throw new TypeError("Value must contain strict JSON enumerable data properties");
			}
			if (property.value === undefined && omitUndefined) continue;
			define(result, key, copy(property.value, parents, omitUndefined));
		}
		return result;
	} finally {
		parents.delete(value);
	}
}

function check(value: unknown, parents: Set<object>): boolean {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) {
		if (Object.getPrototypeOf(value) !== Array.prototype) return false;
		const keys = Reflect.ownKeys(value);
		if (keys.length !== value.length + 1 || keys.some((key) => typeof key !== "string")) return false;
		if (parents.has(value)) return false;
		parents.add(value);
		try {
			for (let i = 0; i < value.length; i++) {
				const property = Object.getOwnPropertyDescriptor(value, String(i));
				if (property === undefined || !property.enumerable || !("value" in property) || !check(property.value, parents))
					return false;
			}
			return true;
		} finally {
			parents.delete(value);
		}
	}
	if (typeof value !== "object" || value === null) return false;
	const prototype: object | null = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return false;
	if (Reflect.ownKeys(value).some((key) => typeof key !== "string")) return false;
	if (parents.has(value)) return false;
	parents.add(value);
	try {
		for (const property of Object.values(Object.getOwnPropertyDescriptors(value))) {
			if (!property.enumerable || !("value" in property) || !check(property.value, parents)) return false;
		}
		return true;
	} finally {
		parents.delete(value);
	}
}
