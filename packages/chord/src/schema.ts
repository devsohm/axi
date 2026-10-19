import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { type ChordErrorReason, invalid } from "./errors.ts";

type Schema = Readonly<Record<string, unknown>>;
const schemaObject = (value: unknown): Schema =>
	value !== null && typeof value === "object" ? (value as Schema) : value === false ? { not: {} } : {};

export function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const object = value as Record<string, unknown>;
	const keys = Object.keys(object)
		.filter((key) => object[key] !== undefined)
		.sort();
	return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}
export function hash64(text: string): string {
	let first = 0x811c9dc5;
	let second = 0x01000193 ^ 0x5bd1e995;
	for (let index = 0; index < text.length; index++) {
		const unit = text.charCodeAt(index);
		first = Math.imul(first ^ unit, 0x01000193);
		second = Math.imul(second ^ unit, 0x5bd1e995) ^ (second >>> 13);
	}
	return (first >>> 0).toString(16).padStart(8, "0") + (second >>> 0).toString(16).padStart(8, "0");
}
export function deepEqual(a: unknown, b: unknown): boolean {
	return a === b || canonicalJson(a) === canonicalJson(b);
}
export function assertValid(reason: ChordErrorReason, what: string, schema: TSchema, value: unknown): void {
	if (Value.Check(schema, value)) return;
	const errors = [...Value.Errors(schema, value)].slice(0, 3);
	throw invalid(
		reason,
		`${what}: ${errors.map((item) => `${item.instancePath || "/"} ${item.message}`).join("; ")}`,
		errors,
	);
}
export function normalize(schema: TSchema, value: unknown, what: string): unknown {
	const result = Value.Clean(schema, Value.Default(schema, Value.Clone(value ?? {})));
	assertValid("input", what, schema, result);
	return result;
}
function defaults(schema: Schema, value: unknown): unknown {
	if (Array.isArray(value)) {
		const items = schema.items;
		return Array.isArray(items)
			? value.map((item, index) => defaults(schemaObject(items[index]), item))
			: value.map((item) => defaults(schemaObject(items), item));
	}
	if (value === null || typeof value !== "object") return value;
	const result: Record<string, unknown> = {},
		properties = schemaObject(schema.properties);
	for (const [name, item] of Object.entries(value)) {
		const field = schemaObject(properties[name]);
		if (!("default" in field) || !deepEqual(field.default, item)) result[name] = defaults(field, item);
	}
	return result;
}
export function canonicalIdentity(schema: TSchema, value: unknown): string {
	return canonicalJson(defaults(schemaObject(schema), value));
}

const constraints = [
	"minLength",
	"maxLength",
	"pattern",
	"format",
	"minimum",
	"maximum",
	"exclusiveMinimum",
	"exclusiveMaximum",
	"multipleOf",
	"minItems",
	"maxItems",
	"uniqueItems",
	"minProperties",
	"maxProperties",
];
const understood = new Set([
	...constraints,
	"type",
	"properties",
	"required",
	"additionalProperties",
	"patternProperties",
	"items",
	"additionalItems",
	"const",
	"enum",
	"anyOf",
	"parameters",
	"returnType",
]);
const annotations = new Set([
	"title",
	"description",
	"default",
	"examples",
	"$id",
	"$schema",
	"$comment",
	"readOnly",
	"writeOnly",
	"deprecated",
]);
const validation = (value: unknown): Schema =>
	Object.fromEntries(Object.entries(schemaObject(value)).filter(([key]) => !annotations.has(key)));
function types(value: Schema): readonly unknown[] | undefined {
	return typeof value.type === "string" ? [value.type] : Array.isArray(value.type) ? value.type : undefined;
}
export function fits(subSchema: unknown, supSchema: unknown): boolean {
	const from = validation(subSchema),
		to = validation(supSchema);
	if (!Object.keys(to).length || deepEqual(from, to)) return true;
	if (Object.keys(to).some((key) => !understood.has(key))) return false;
	if (to.additionalProperties !== undefined && typeof to.additionalProperties !== "boolean") return false;
	if (Array.isArray(from.anyOf)) return from.anyOf.every((branch) => fits(branch, to));
	if (Array.isArray(to.anyOf)) return to.anyOf.some((branch) => fits(from, branch));
	if ("const" in to) return "const" in from && deepEqual(from.const, to.const);
	if (Array.isArray(to.enum)) {
		const allowed = to.enum,
			values = "const" in from ? [from.const] : Array.isArray(from.enum) ? from.enum : undefined;
		return values?.every((value) => allowed.some((entry) => deepEqual(value, entry))) ?? false;
	}
	for (const key of constraints) if (key in to && !deepEqual(from[key], to[key])) return false;
	const supTypes = types(to),
		subTypes = types(from);
	if (
		!subTypes ||
		!supTypes ||
		!subTypes.every((type) => supTypes.includes(type) || (type === "integer" && supTypes.includes("number")))
	)
		return false;
	if ("const" in from || Array.isArray(from.enum)) return true;
	if (subTypes.includes("object") && !objectsFit(from, to)) return false;
	if (subTypes.includes("array")) {
		const a = from.items,
			b = to.items;
		if (Array.isArray(b)) {
			if (!Array.isArray(a) || a.length !== b.length || !a.every((item, i) => fits(item, b[i]))) return false;
		} else if (Array.isArray(a) ? !a.every((item) => fits(item, b)) : !fits(a, b)) return false;
	}
	if (subTypes.includes("function")) {
		const a = (from.parameters ?? []) as unknown[],
			b = (to.parameters ?? []) as unknown[];
		return a.length <= b.length && a.every((item, i) => fits(b[i], item)) && fits(from.returnType, to.returnType);
	}
	return true;
}
function objectsFit(from: Schema, to: Schema): boolean {
	const a = schemaObject(from.properties),
		b = schemaObject(to.properties);
	const required = new Set((from.required ?? []) as string[]);
	for (const key of (to.required ?? []) as string[]) if (!required.has(key)) return false;
	for (const [key, property] of Object.entries(b)) {
		if (
			key in a
				? !fits(a[key], property)
				: typeof from.additionalProperties === "object" && !fits(from.additionalProperties, property)
		)
			return false;
	}
	if (
		to.additionalProperties === false &&
		(from.additionalProperties !== false || Object.keys(a).some((key) => !(key in b)))
	)
		return false;
	const patterns = schemaObject(to.patternProperties);
	if (!Object.keys(patterns).length) return true;
	const existing = schemaObject(from.patternProperties);
	if (from.additionalProperties !== false && !Object.keys(existing).length) return false;
	for (const [pattern, property] of Object.entries(patterns)) {
		const matcher = new RegExp(pattern, "u");
		for (const [key, item] of Object.entries(a))
			if (!(key in b) && matcher.test(key) && !fits(item, property)) return false;
		if (Object.keys(existing).length && (!(pattern in existing) || !fits(existing[pattern], property))) return false;
	}
	for (const pattern of Object.keys(existing)) if (!(pattern in patterns)) return false;
	return true;
}
