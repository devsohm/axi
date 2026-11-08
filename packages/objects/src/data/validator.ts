import { objectsMetrics } from "../telemetry.ts";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import type { TLocalizedValidationError } from "typebox/error";
import { ResetExternal, ResetFunctions } from "typebox/schema";
import { Value } from "typebox/value";
import type { Context } from "../context/index.ts";
import type { BytesMarker, TSchema } from "../contracts/schema.ts";
import { invalid } from "./errors.ts";

type Owner = { readonly schema: TSchema };
type ValidationError = { readonly path: string; readonly message: string };
export type Validator = {
	readonly check: (value: unknown) => boolean;
	readonly errors: (value: unknown) => ValidationError[];
};
const compiled = new WeakMap<Owner, Validator>();

function receivedType(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	if (value instanceof Uint8Array) return "bytes";
	if (typeof value === "number") return Number.isInteger(value) ? "integer" : Number.isFinite(value) ? "number" : String(value);
	return typeof value;
}

function diagnostic(error: TLocalizedValidationError, value: unknown): ValidationError[] {
	const path = error.instancePath;
	if (error.keyword === "required") return error.params.requiredProperties.map(property => ({
		path: `${path}/${property.replaceAll("~", "~0").replaceAll("/", "~1")}`, message: "missing",
	}));
	let message = error.message;
	if (error.keyword === "type") message = `expected ${[error.params.type].flat().join(" or ")}, got ${receivedType(Value.Pointer.Get(value, path))}`;
	else if (error.keyword === "~refine") message = error.params.message;
	else if (error.keyword === "boolean") message = error.schemaPath.endsWith("/additionalProperties") ? "unknown field" : "no value is allowed here";
	else if (["minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties"].includes(error.keyword) && "limit" in error.params) {
		const unit = error.keyword.endsWith("Length") ? "characters" : error.keyword.endsWith("Items") ? "items" : "properties";
		message = `expected at ${error.keyword.startsWith("min") ? "least" : "most"} ${error.params.limit} ${unit}`;
	}
	else if (["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"].includes(error.keyword) && "comparison" in error.params && "limit" in error.params)
		message = `expected ${error.params.comparison} ${error.params.limit}`;
	else if (error.keyword === "pattern") message = `expected to match ${error.params.pattern}`;
	else if (error.keyword === "multipleOf") message = `expected a multiple of ${error.params.multipleOf}`;
	else if (error.keyword === "uniqueItems") message = "expected unique items";
	else if (error.keyword === "const") message = `expected ${JSON.stringify(error.params.allowedValue)}`;
	else if (error.keyword === "enum") message = `expected one of ${listed(error.params.allowedValues)}`;
	return [{ path, message }];
}

function listed(values: unknown[]): string {
	const json = JSON.stringify(values.slice(0, 20));
	return values.length <= 20 ? json : `${json.slice(0, -1)}, ... and ${values.length - 20} more]`;
}

const keywordOrder = ["type", "enum", "const", "minLength", "maxLength", "pattern", "~refine", "minimum", "maximum",
	"exclusiveMinimum", "exclusiveMaximum", "multipleOf", "required", "properties", "patternProperties", "additionalProperties",
	"minProperties", "maxProperties", "items", "prefixItems", "additionalItems", "minItems", "maxItems", "uniqueItems", "allOf", "anyOf"];
function schemaAt(root: TSchema, pointer: string): unknown {
	let node: unknown = root, scope: object = root;
	const keys = pointer === "#" ? [] : pointer.slice(2).split("/").map(key => key.replaceAll("~1", "/").replaceAll("~0", "~"));
	for (const key of [...keys, undefined]) {
		const seen = new Set<object>();
		while (typeof node === "object" && node !== null && !seen.has(node)) {
			if (typeof Reflect.get(node, "$id") === "string") scope = node;
			const ref: unknown = Reflect.get(node, "$ref");
			if (typeof ref !== "string" || ref !== "#" && !ref.startsWith("#/")) break;
			seen.add(node);
			node = ref === "#" ? scope : Value.Pointer.Get(scope, ref.slice(1));
		}
		if (key === undefined) return node;
		node = typeof node === "object" && node !== null ? Reflect.get(node, key) : undefined;
	}
}
function order(error: TLocalizedValidationError, schema: TSchema): number[] {
	const segments = error.schemaPath === "#" ? [] : error.schemaPath.slice(2).split("/").map(key => key.replaceAll("~1", "/").replaceAll("~0", "~"));
	let names = false;
	const ranks: number[] = [];
	for (const [index, key] of [...segments, error.keyword].entries()) {
		const prefix = segments.slice(0, index).map(segment => segment.replaceAll("~", "~0").replaceAll("/", "~1"));
		const node = schemaAt(schema, index ? `#/${prefix.join("/")}` : "#");
		const keys = typeof node === "object" && node !== null ? Object.keys(node) : [];
		const rank = Array.isArray(node) ? Number(key) : names ? keys.indexOf(key) : keywordOrder.indexOf(key);
		ranks.push(rank < 0 ? keywordOrder.length : rank);
		names = ["properties", "patternProperties", "$defs"].includes(key);
	}
	return ranks;
}
function properties(schema: unknown): object {
	if (typeof schema !== "object" || schema === null || !("properties" in schema)) return {};
	return typeof schema.properties === "object" && schema.properties !== null ? schema.properties : {};
}
function unionTag(branches: unknown[], input: unknown): { key: string; values: unknown[]; index: number } | undefined {
	if (typeof input !== "object" || input === null || Array.isArray(input)) return;
	for (const key of Object.keys(properties(branches[0]))) {
		const values = branches.map(branch => {
			const field: unknown = Reflect.get(properties(branch), key);
			return typeof field === "object" && field !== null && Object.hasOwn(field, "const") ? Reflect.get(field, "const") : undefined;
		});
		if (values.some(value => value === undefined || value !== null && typeof value === "object") || new Set(values).size !== values.length) continue;
		return { key, values, index: values.indexOf(Reflect.get(input, key)) };
	}
}
function explained(validator: ReturnType<typeof Compile>, value: unknown): ValidationError[] {
	const schema = validator.Type();
	let errors = validator.Errors(value);
	for (const summary of errors) {
		if (summary.keyword !== "anyOf") continue;
		const prefix = `${summary.schemaPath}/anyOf/`;
		const branches = Reflect.get(schemaAt(schema, summary.schemaPath) as object, "anyOf") as unknown[];
		const input: unknown = Value.Pointer.Get(value, summary.instancePath);
		const tag = unionTag(branches, input);
		if (tag?.index === -1) {
			errors = errors.filter(error => error !== summary && !error.schemaPath.startsWith(prefix));
			errors.push({ ...summary, instancePath: `${summary.instancePath}/${tag.key.replaceAll("~", "~0").replaceAll("/", "~1")}`,
				message: `expected one of ${listed(tag.values)}` });
			continue;
		}
		let selected = tag?.index ?? -1, declared = -1, depth = -1;
		if (!tag) for (const [index, branch] of branches.entries()) {
			const path = `${prefix}${index}`;
			const failures = errors.filter(error => error.schemaPath === path || error.schemaPath.startsWith(`${path}/`));
			if (!failures.length) continue;
			const fields = properties(branch);
			const count = typeof input === "object" && input !== null ? Object.keys(input).filter(key => Object.hasOwn(fields, key)).length : 0;
			const first = failures.toSorted((a, b) => compareOrder(order(a, schema), order(b, schema)))[0];
			const pathLength = diagnostic(first, value)[0].path.length;
			if (count > declared || count === declared && pathLength > depth) {
				selected = index; declared = count; depth = pathLength;
			}
		}
		if (selected >= 0) errors = errors.filter(error => error !== summary && (!error.schemaPath.startsWith(prefix)
			|| error.schemaPath === `${prefix}${selected}` || error.schemaPath.startsWith(`${prefix}${selected}/`)));
	}
	return errors.filter(error => error.keyword !== "additionalProperties")
		.toSorted((a, b) => compareOrder(order(a, schema), order(b, schema)))
		.flatMap(error => diagnostic(error, value));
}
function compareOrder(a: number[], b: number[]): number {
	for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
	return a.length - b.length;
}

function validationSchema(schema: TSchema, root: TSchema = schema): TSchema {
	if (typeof schema !== "object" || schema === null) return schema;
	const scope = typeof Reflect.get(schema, "$id") === "string" ? schema : root;
	const reference: unknown = Reflect.get(schema, "$ref");
	if (typeof reference === "string" && reference.startsWith("#/") && Value.Pointer.Get(scope, decodeURIComponent(reference.slice(1))) === undefined) {
		const base = new URL(Reflect.get(scope, "$id") ?? "https://json-schema.invalid/root.json", "https://json-schema.invalid/root.json");
		throw new Error(`Unresolved $ref ${reference} in ${base.href}`);
	}
	const descriptors = Object.getOwnPropertyDescriptors(schema);
	for (const descriptor of Object.values(descriptors)) {
		descriptor.configurable = true;
		if ("value" in descriptor) descriptor.writable = true;
	}
	const result = Object.defineProperties({}, descriptors);
	Reflect.deleteProperty(result, "format");
	for (const key of ["items", "additionalItems", "additionalProperties"]) {
		const child: TSchema | TSchema[] | undefined = Reflect.get(schema, key);
		if (child !== undefined)
			Reflect.set(result, key, Array.isArray(child) ? child.map(item => validationSchema(item, scope)) : validationSchema(child, scope));
	}
	for (const key of ["anyOf", "allOf", "prefixItems"]) {
		const children: TSchema[] | undefined = Reflect.get(schema, key);
		if (children !== undefined) Reflect.set(result, key, children.map(child => validationSchema(child, scope)));
	}
	for (const key of ["properties", "patternProperties", "$defs"]) {
		const fields: Record<string, TSchema> | undefined = Reflect.get(schema, key);
		if (fields !== undefined)
			Reflect.set(result, key, Object.fromEntries(Object.entries(fields).map(([name, child]) => [name, validationSchema(child, scope)])));
	}
	if (Reflect.get(schema, "type") === "bytes") {
		const marker = schema as BytesMarker, minimum = marker.minLength ?? 0, maximum = marker.maxLength ?? Infinity;
		return Type.Refine(result,
			(value: unknown) => value instanceof Uint8Array && value.length >= minimum && value.length <= maximum,
			(value: unknown) => !(value instanceof Uint8Array) ? `expected bytes, got ${receivedType(value)}`
				: value.length < minimum ? `expected at least ${minimum} bytes` : `expected at most ${maximum} bytes`);
	}
	return result;
}

export function validatorFor(owner: Owner, context: Context): Validator {
	const existing = compiled.get(owner);
	if (existing) return existing;
	objectsMetrics(context.telemetry.metrics).counter("objects.data.compilations").add(1);
	let validator: ReturnType<typeof Compile>;
	try { validator = Compile(validationSchema(owner.schema)); }
	finally { ResetFunctions(); ResetExternal(); }
	const checked: Validator = {
		check: value => validator.Check(value),
		errors: value => explained(validator, value),
	};
	compiled.set(owner, checked);
	return checked;
}
export function check(validator: Validator, value: unknown, reason: "args" | "params" | "host_address", context: Context): void {
	objectsMetrics(context.telemetry.metrics).counter("objects.data.validations").add(1);
	if (validator.check(value)) return;
	objectsMetrics(context.telemetry.metrics).counter("objects.data.walks").add(1);
	const error = validator.errors(value)[0]!, path = error.path || "/";
	throw invalid(reason, `${reason}${path === "/" ? "" : path}: ${error.message}`, { path });
}
