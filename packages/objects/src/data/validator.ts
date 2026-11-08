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
	else if (error.keyword === "boolean" && error.schemaPath.endsWith("/additionalProperties")) message = "unknown field";
	return [{ path, message }];
}

function validationSchema(schema: TSchema): TSchema {
	if (typeof schema !== "object" || schema === null) return schema;
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
			Reflect.set(result, key, Array.isArray(child) ? child.map(validationSchema) : validationSchema(child));
	}
	for (const key of ["anyOf", "allOf", "prefixItems"]) {
		const children: TSchema[] | undefined = Reflect.get(schema, key);
		if (children !== undefined) Reflect.set(result, key, children.map(validationSchema));
	}
	for (const key of ["properties", "patternProperties", "$defs"]) {
		const fields: Record<string, TSchema> | undefined = Reflect.get(schema, key);
		if (fields !== undefined)
			Reflect.set(result, key, Object.fromEntries(Object.entries(fields).map(([name, child]) => [name, validationSchema(child)])));
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
		errors: value => validator.Errors(value).flatMap(error => diagnostic(error, value)),
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
