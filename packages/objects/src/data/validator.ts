import { objectsMetrics } from "../telemetry.ts";
import { Compile, type Validator } from "typebox/compile";
import { ResetExternal, ResetFunctions } from "typebox/schema";
import { Errors } from "typebox/value";
import type { Context } from "../context/index.ts";
import type { TSchema } from "../contracts/schema.ts";
import { invalid } from "./errors.ts";

type Owner = { readonly schema: TSchema };
const compiled = new WeakMap<Owner, Validator>();

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
	return result;
}

export function validatorFor(owner: Owner, context: Context): Validator {
	const existing = compiled.get(owner);
	if (existing) return existing;
	objectsMetrics(context.telemetry.metrics).counter("objects.data.compilations").add(1);
	let validator: Validator;
	try { validator = Compile(validationSchema(owner.schema)); }
	finally { ResetFunctions(); ResetExternal(); }
	compiled.set(owner, validator);
	return validator;
}
export function check(validator: Validator, value: unknown, reason: "args" | "params" | "host_address", context: Context): void {
	objectsMetrics(context.telemetry.metrics).counter("objects.data.validations").add(1);
	if (validator.Check(value)) return;
	objectsMetrics(context.telemetry.metrics).counter("objects.data.walks").add(1);
	const error = Errors(validator.Type(), value)[0]!;
	const location = error.instancePath;
	let path = location || "/", problem = error.message;
	if (error.keyword === "required") {
		const property = String(error.params.requiredProperties[0]).replaceAll("~", "~0").replaceAll("/", "~1");
		path = `${location}/${property}`;
		problem = "missing";
	}
	else if (error.keyword === "boolean" && error.schemaPath.endsWith("/additionalProperties")) problem = "unknown field";
	throw invalid(reason, `${reason}${path === "/" ? "" : path}: ${problem}`, { path });
}
