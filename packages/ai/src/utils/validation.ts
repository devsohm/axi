import { Compile } from "typebox/compile";
import type { TLocalizedValidationError } from "typebox/error";
import { Value } from "typebox/value";
import type { Tool, ToolCall } from "../types.ts";

interface Schema {
	type?: string | string[];
	properties?: Record<string, Schema>;
	required?: string[];
	items?: Schema | Schema[];
	additionalProperties?: boolean | Schema;
	allOf?: Schema[];
	anyOf?: Schema[];
	oneOf?: Schema[];
	$ref?: string;
}
const cache = new WeakMap<object, ReturnType<typeof Compile>>();
function validator(schema: Tool["parameters"]): ReturnType<typeof Compile> {
	const old = cache.get(schema);
	if (old) return old;
	const compiled = Compile(schema);
	cache.set(schema, compiled);
	return compiled;
}
function subValidator(schema: Schema): ReturnType<typeof Compile> | undefined {
	try {
		return validator(schema);
	} catch {
		return undefined;
	}
}
function matches(value: unknown, type: string): boolean {
	switch (type) {
		case "number":
			return typeof value === "number";
		case "integer":
			return typeof value === "number" && Number.isInteger(value);
		case "boolean":
			return typeof value === "boolean";
		case "string":
			return typeof value === "string";
		case "null":
			return value === null;
		case "array":
			return Array.isArray(value);
		case "object":
			return typeof value === "object" && value !== null && !Array.isArray(value);
		default:
			return false;
	}
}
function primitive(value: unknown, type: string): unknown {
	if (type === "string")
		return value === null ? "" : typeof value === "number" || typeof value === "boolean" ? String(value) : value;
	if (type === "null") return value === "" || value === 0 || value === false ? null : value;
	if (type === "boolean") {
		if (value === null || value === 0 || value === "false") return false;
		if (value === 1 || value === "true") return true;
		return value;
	}
	if (type === "number" || type === "integer") {
		if (value === null) return 0;
		if (typeof value === "boolean") return Number(value);
		if (typeof value === "string" && value.trim()) {
			const parsed = Number(value);
			if (type === "integer" ? Number.isInteger(parsed) : Number.isFinite(parsed)) return parsed;
		}
	}
	return value;
}
function union(value: unknown, branches: Schema[]): unknown {
	for (const schema of branches) if (subValidator(schema)?.Check(value)) return value;
	for (const schema of branches) {
		const result = coerce(structuredClone(value), schema);
		if (subValidator(schema)?.Check(result)) return result;
	}
	return value;
}
function coerce(value: unknown, schema: Schema): unknown {
	let current = value;
	if (Array.isArray(schema.allOf)) for (const branch of schema.allOf) current = coerce(current, branch);
	if (Array.isArray(schema.anyOf)) current = union(current, schema.anyOf);
	if (Array.isArray(schema.oneOf)) current = union(current, schema.oneOf);
	const types =
		typeof schema.type === "string"
			? [schema.type]
			: Array.isArray(schema.type)
				? schema.type.filter((type): type is string => typeof type === "string")
				: [];
	if (!(types.length > 1 && types.some((type) => matches(current, type))))
		for (const type of types) {
			const next = primitive(current, type);
			if (next !== current) {
				current = next;
				break;
			}
		}
	if (types.includes("array") && Array.isArray(current)) {
		for (let index = 0; index < current.length; index++) {
			const item = Array.isArray(schema.items) ? schema.items[index] : schema.items;
			if (item && typeof item === "object") current[index] = coerce(current[index], item);
		}
	}
	if (types.includes("object") && typeof current === "object" && current !== null && !Array.isArray(current)) {
		const object = current as Record<string, unknown>;
		for (const [key, property] of Object.entries(schema.properties ?? {}))
			if (key in object) object[key] = coerce(object[key], property);
		if (schema.additionalProperties && typeof schema.additionalProperties === "object")
			for (const [key, value] of Object.entries(object))
				if (!Object.hasOwn(schema.properties ?? {}, key)) object[key] = coerce(value, schema.additionalProperties);
	}
	return current;
}
function omitOptionalNulls(value: unknown, schema: Schema): void {
	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index++) {
			const item = Array.isArray(schema.items) ? schema.items[index] : schema.items;
			if (item) omitOptionalNulls(value[index], item);
		}
	} else if (typeof value === "object" && value !== null && schema.properties) {
		const object = value as Record<string, unknown>,
			required = new Set(schema.required ?? []);
		for (const [key, property] of Object.entries(schema.properties)) {
			if (!(key in object)) continue;
			if (
				object[key] === null &&
				!required.has(key) &&
				typeof property.$ref !== "string" &&
				subValidator(property)?.Check(null) === false
			)
				delete object[key];
			else omitOptionalNulls(object[key], property);
		}
	}
}
function location(error: TLocalizedValidationError): string {
	const base = error.instancePath.replace(/^\//, "").replaceAll("/", ".");
	if (error.keyword === "required" && "requiredProperties" in error.params) {
		const properties = error.params.requiredProperties;
		if (Array.isArray(properties) && typeof properties[0] === "string" && properties[0])
			return base ? `${base}.${properties[0]}` : properties[0];
	}
	return base || "root";
}
export function validateToolCall(tools: Tool[], call: ToolCall): any {
	const tool = tools.find((tool) => tool.name === call.name);
	if (!tool) throw new Error(`Tool "${call.name}" not found`);
	return validateToolArguments(tool, call);
}
export function validateToolArguments(tool: Tool, call: ToolCall): any {
	if (call.argumentsError) throw new Error(`Invalid arguments for tool "${call.name}": ${call.argumentsError}`);
	const args = structuredClone(call.arguments),
		schema = tool.parameters as Schema;
	omitOptionalNulls(args, schema);
	Value.Convert(tool.parameters, args);
	const compiled = validator(tool.parameters);
	if (!Object.getOwnPropertySymbols(tool.parameters).includes(Symbol.for("TypeBox.Kind"))) {
		const converted = coerce(args, schema);
		if (converted !== args) {
			if (typeof args === "object" && args !== null && typeof converted === "object" && converted !== null) {
				for (const key of Object.keys(args)) delete args[key];
				Object.assign(args, converted);
			} else return compiled.Check(converted) ? converted : args;
		}
	}
	if (compiled.Check(args)) return args;
	const failures =
		compiled
			.Errors(args)
			.map((error) => `  - ${location(error)}: ${error.message}`)
			.join("\n") || "Unknown validation error";
	throw new Error(
		`Validation failed for tool "${call.name}":\n${failures}\n\nReceived arguments:\n${JSON.stringify(call.arguments, null, 2)}`,
	);
}
