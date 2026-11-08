import { isJsonValue, type JsonValue } from "../json.ts";
import type { TSchema } from "./schema.ts";

export type Snapshot = { readonly schema: TSchema; readonly normal: JsonValue; readonly bytes: boolean };
const annotations = new Set(["title", "description", "examples", "$comment", "deprecated"]);
const dataKeywords = new Set(("const default $ref $id pattern format minLength maxLength minimum maximum exclusiveMinimum exclusiveMaximum " +
	"multipleOf minItems maxItems uniqueItems minProperties maxProperties readOnly writeOnly").split(" "));
const schemaKeywords = new Set(["additionalProperties", "additionalItems"]);
const listKeywords = new Set(["anyOf", "allOf", "prefixItems"]);
const mapKeywords = new Set(["properties", "patternProperties", "$defs"]);
const types = new Set(["null", "boolean", "number", "integer", "string", "array", "object", "bytes"]);
type Pair = readonly [schema: unknown, normal: JsonValue, bytes: boolean];
function plain(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) &&
		[null, Object.prototype].includes(Object.getPrototypeOf(value));
}
function entries(value: object, path: string): [string, unknown][] {
	const result: [string, unknown][] = [];
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key !== "string") throw new Error(`${path}: symbol keys are not supported`);
		const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
		if (!("value" in descriptor)) throw new Error(`${path}.${key}: accessors are not supported`);
		if (!descriptor.enumerable) {
			if (key === "~optional" && descriptor.value === true) continue;
			if (key === "~kind" && typeof descriptor.value === "string") continue;
			throw new Error(`${path}.${key}: non-enumerable keys are not supported`);
		}
		result.push([key, descriptor.value]);
	}
	return result.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
}
function sortedData(value: JsonValue): JsonValue {
	if (!value || typeof value !== "object") return value;
	return Array.isArray(value) ? value.map(sortedData)
		: Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedData(value[key]!)]));
}
function copyData(raw: unknown, path: string): Pair {
	if (!isJsonValue(raw)) throw new Error(`${path}: expected JSON data (finite numbers, plain objects and arrays)`);
	const value = sortedData(raw);
	return [value, value, false];
}
function snapshot(source: unknown, path: string, closed: boolean): Snapshot {
	const ancestors = new Set<object>();
	function node(raw: unknown, at: string, property = false): Pair {
		if (typeof raw === "boolean") return [raw, raw, false];
		if (!plain(raw)) throw new Error(`${at}: expected a schema`);
		if (raw["~optional"] === true && !property) throw new Error(`${at}: expected a schema`);
		if (ancestors.has(raw)) throw new Error(`${at}: cyclic schema; use $defs and $ref for recursion`);
		const bytes = raw.type === "bytes";
		ancestors.add(raw);
		const owned: [string, unknown][] = [], normal: [string, JsonValue][] = [];
		let containsBytes = bytes;
		for (const [key, value] of entries(raw, at)) {
			if (bytes && !annotations.has(key) && !["type", "minLength", "maxLength"].includes(key))
				throw new Error(`${at}: unsupported keyword "${key}"`);
			const next = `${at}.${key}`;
			let copied: Pair;
			if (schemaKeywords.has(key)) copied = node(value, next);
			else if (listKeywords.has(key) || (key === "items" && Array.isArray(value))) {
				if (!Array.isArray(value)) throw new Error(`${next}: expected an array of schemas`);
				const items = Array.from(value, (item, i) => node(item, `${next}[${i}]`));
				copied = [items.map((item) => item[0]), items.map((item) => item[1]), items.some((item) => item[2])];
			} else if (key === "items") copied = node(value, next);
			else if (mapKeywords.has(key)) {
				if (!plain(value)) throw new Error(`${next}: expected an object of schemas`);
			const fields = entries(value, next).map(([name, child]) => [name, node(child, `${next}.${name}`, key === "properties")] as const);
				copied = [Object.fromEntries(fields.map(([name, result]) => [name, result[0]])),
					Object.fromEntries(fields.map(([name, result]) => [name, result[1]])), fields.some(([, result]) => result[2])];
			} else if (key === "type") {
				if (typeof value !== "string" || !types.has(value)) throw new Error(`${next}: unsupported type ${JSON.stringify(value)}`);
				copied = [value, value, false];
			} else if (key === "required") {
				if (!Array.isArray(value) || !value.every((name) => typeof name === "string"))
					throw new Error(`${next}: expected an array of strings`);
				const sorted = [...value].sort();
				copied = [sorted, sorted, false];
			} else if (key === "enum") {
				const [, data] = copyData(value, next);
				if (!Array.isArray(data)) throw new Error(`${next}: expected an array`);
				data.sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0);
				copied = [data, data, false];
			} else if (dataKeywords.has(key) || annotations.has(key)) copied = copyData(value, next);
			else throw new Error(`${at}: unsupported keyword "${key}"`);
			owned.push([key, copied[0]]);
			if (!annotations.has(key)) normal.push([key, copied[1]]);
			containsBytes ||= copied[2];
		}
		ancestors.delete(raw);
		const schema = Object.fromEntries(owned);
		if (closed && (schema.type === "object" || "properties" in schema) &&
			!("patternProperties" in schema && !("properties" in schema)) && schema.additionalProperties !== false)
			throw new Error(`${at}: argument objects must be closed (additionalProperties: false)`);
		if (bytes) {
			for (const value of [schema.minLength, schema.maxLength])
				if (value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0))
					throw new Error(`${at}: bytes bounds must be non-negative integers`);
		}
		return [schema, Object.fromEntries(normal), containsBytes];
	}
	const [schema, normal, bytes] = node(source, path);
	return { schema: schema as TSchema, normal, bytes };
}
export function snapshotSchema(source: unknown, path: string): Snapshot { return snapshot(source, path, false); }
export function snapshotArguments(source: unknown, path: string): Snapshot { return snapshot(source, path, true); }
