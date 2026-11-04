import { Compile, type Validator } from "typebox/compile";
import { ResetExternal, ResetFunctions } from "typebox/schema";
import { Errors } from "typebox/value";
import type { Context } from "../context/index.ts";
import type { TSchema } from "../contracts/schema.ts";
import { invalid } from "./errors.ts";

type Owner = { readonly schema: TSchema };
const compiled = new WeakMap<Owner, Validator>();
export function validatorFor(owner: Owner, context: Context): Validator {
	const existing = compiled.get(owner);
	if (existing) return existing;
	context.telemetry.metrics?.counter("objects.data.compilations").add(1);
	let validator: Validator;
	try { validator = Compile(owner.schema); }
	finally { ResetFunctions(); ResetExternal(); }
	compiled.set(owner, validator);
	return validator;
}
export function check(validator: Validator, value: unknown, reason: "args" | "params" | "host_address", context: Context): void {
	context.telemetry.metrics?.counter("objects.data.validations").add(1);
	if (validator.Check(value)) return;
	context.telemetry.metrics?.counter("objects.data.walks").add(1);
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
