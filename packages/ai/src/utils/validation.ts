import { Type } from "typebox";
import { Compile } from "typebox/compile";
import type { TLocalizedValidationError } from "typebox/error";
import { Value } from "typebox/value";
import type { Tool, ToolCall } from "../types.ts";

type Schema = SchemaNode | boolean;
interface SchemaNode {
	type?: string | string[];
	properties?: Record<string, Schema>;
	patternProperties?: Record<string, Schema>;
	required?: string[];
	items?: Schema | Schema[];
	prefixItems?: Schema[];
	additionalProperties?: boolean | Schema;
	allOf?: Schema[];
	anyOf?: Schema[];
	oneOf?: Schema[];
	const?: unknown;
	enum?: unknown[];
	$ref?: string;
	$id?: string;
}
const cache = new WeakMap<
	object,
	{
		references: Record<string, Tool["parameters"]>;
		validators: WeakMap<object, ReturnType<typeof Compile>>;
	}
>();
const conversions = new Map<string, Tool["parameters"]>([
	["string", Type.String()],
	["number", Type.Number()],
	["integer", Type.Integer()],
	["boolean", Type.Boolean()],
	["null", Type.Null()],
	["array", Type.Array(Type.Unknown())],
]);
function resolve(schema: SchemaNode, root: SchemaNode): Schema {
	if (schema.$ref !== "#" && !schema.$ref?.startsWith("#/")) return schema;
	const visited = new Set<Schema>();
	while ((schema.$ref === "#" || schema.$ref?.startsWith("#/")) && !visited.has(schema)) {
		visited.add(schema);
		const target = schema.$ref === "#" ? root : Value.Pointer.Get(root, schema.$ref.slice(1));
		if (typeof target === "boolean") return target;
		if (!Type.IsSchema(target)) break;
		schema = target;
	}
	return schema;
}
function schemaForValidation(schema: SchemaNode, root: SchemaNode): Tool["parameters"] {
	const scope = typeof schema.$id === "string" ? schema : root;
	if (
		typeof schema.$ref === "string" &&
		(schema.$ref === "#" || schema.$ref.startsWith("#/")) &&
		resolve(schema, scope) === schema
	)
		return Type.Never();
	const copy: Record<string, unknown> = { ...schema };
	for (const key of ["$defs", "definitions", "properties", "patternProperties", "dependentSchemas"]) {
		const members = copy[key];
		if (Type.IsSchema(members))
			copy[key] = Object.fromEntries(
				Object.entries(members).map(([name, child]) => [
					name,
					Type.IsSchema(child) ? schemaForValidation(child, scope) : child,
				]),
			);
	}
	for (const key of [
		"items",
		"prefixItems",
		"allOf",
		"anyOf",
		"oneOf",
		"additionalProperties",
		"additionalItems",
		"not",
		"if",
		"then",
		"else",
		"contains",
		"propertyNames",
		"unevaluatedProperties",
		"unevaluatedItems",
	]) {
		const child = copy[key];
		if (Array.isArray(child))
			copy[key] = child.map((item) => (Type.IsSchema(item) ? schemaForValidation(item, scope) : item));
		else if (Type.IsSchema(child)) copy[key] = schemaForValidation(child, scope);
	}
	return copy;
}
function validator(schema: Tool["parameters"], root: SchemaNode): ReturnType<typeof Compile> {
	let owner = cache.get(root);
	if (!owner) {
		const references: Record<string, Tool["parameters"]> = Object.create(null);
		const pending: unknown[] = [root];
		while (pending.length) {
			const current = pending.pop();
			if (Array.isArray(current)) pending.push(...current);
			else if (Type.IsSchema(current)) {
				if (current !== root && "$id" in current && typeof current.$id === "string") continue;
				if (
					"$ref" in current &&
					typeof current.$ref === "string" &&
					(current.$ref === "#" || current.$ref.startsWith("#/"))
				) {
					const reference = { $ref: current.$ref };
					const target = resolve(reference, root);
					if (target === reference) references[current.$ref] = Type.Never();
					else
						references[current.$ref] =
							typeof target === "boolean"
								? target
									? Type.Unknown()
									: Type.Never()
								: schemaForValidation(target, root);
				}
				pending.push(...Object.values(current));
			}
		}
		owner = { references, validators: new WeakMap() };
		cache.set(root, owner);
	}
	const old = owner.validators.get(schema);
	if (old) return old;
	const normalized = schemaForValidation(schema, root);
	const compiled = schema === root ? Compile(normalized) : Compile(owner.references, normalized);
	owner.validators.set(schema, compiled);
	return compiled;
}
function subValidator(schema: Schema, root: SchemaNode): { Check(value: unknown): boolean } | undefined {
	if (typeof schema === "boolean") return { Check: () => schema };
	try {
		return validator(schema, root);
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
type Transform = (value: unknown, schema: Schema) => unknown;
function arrayMembers(value: unknown[], schema: SchemaNode, transform: Transform): unknown[] {
	for (let index = 0; index < value.length; index++) {
		const item = Array.isArray(schema.items) ? schema.items[index] : (schema.prefixItems?.[index] ?? schema.items);
		if (item && typeof item === "object") value[index] = transform(value[index], item);
	}
	return value;
}
function objectMembers(value: unknown, schema: SchemaNode, transform: Transform): unknown {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
	const object = value as Record<string, unknown>;
	for (const [key, property] of Object.entries(schema.properties ?? {}))
		if (Object.hasOwn(object, key) && object[key] !== undefined) object[key] = transform(object[key], property);
	const patterns = Object.entries(schema.patternProperties ?? {}).map(
		([pattern, property]) => [new RegExp(pattern), property] as const,
	);
	if (patterns.length || typeof schema.additionalProperties === "object")
		for (const key of Object.keys(object)) {
			if (object[key] === undefined) continue;
			let matched = Object.hasOwn(schema.properties ?? {}, key);
			for (const [pattern, property] of patterns)
				if (pattern.test(key)) {
					matched = true;
					object[key] = transform(object[key], property);
				}
			if (!matched && schema.additionalProperties && typeof schema.additionalProperties === "object")
				object[key] = transform(object[key], schema.additionalProperties);
		}
	return value;
}
function literal(value: unknown, expected: unknown): unknown {
	const target = conversions.get(typeof expected);
	if (!target) return value;
	const next = Value.Convert(target, value);
	return next === expected ? next : value;
}
function convert(value: unknown, schema: Schema, root: SchemaNode, path: [Schema, unknown][] = []): unknown {
	if (!schema || typeof schema !== "object") return value;
	if (typeof schema.$id === "string") root = schema;
	const descend = (input: unknown, target: Schema): unknown => {
		if (path.some(([node, active]) => node === target && Object.is(active, input))) return input;
		path.push([target, input]);
		try {
			return convert(input, target, root, path);
		} finally {
			path.pop();
		}
	};
	const visit: Transform = (input, target) => convert(input, target, root, path);
	if (typeof schema.$ref === "string") {
		const target = resolve(schema, root);
		return target === schema ? value : descend(value, target);
	}
	if (Object.hasOwn(schema, "const")) return literal(value, schema.const);
	if (Array.isArray(schema.enum)) {
		if (schema.enum.includes(value)) return value;
		for (const member of schema.enum) {
			const next = literal(value, member);
			if (subValidator(schema, root)?.Check(next)) return next;
		}
		return value;
	}
	const branches = schema.anyOf ?? schema.oneOf;
	if (Array.isArray(branches)) {
		if (branches.some((branch) => subValidator(branch, root)?.Check(value))) return objectMembers(value, schema, visit);
		for (const branch of branches) {
			const next = objectMembers(visit(structuredClone(value), branch), schema, visit);
			if (subValidator(schema, root)?.Check(next)) return next;
		}
		return objectMembers(value, schema, visit);
	}
	if (Array.isArray(schema.allOf)) {
		for (const branch of schema.allOf) value = visit(value, branch);
		return objectMembers(value, schema, visit);
	}
	const type =
		schema.type ??
		(schema.properties || schema.patternProperties
			? "object"
			: schema.items !== undefined || schema.prefixItems
				? "array"
				: undefined);
	if (type === "object") return objectMembers(value, schema, visit);
	if (type === "array") {
		if (Array.isArray(value)) return arrayMembers(value, schema, visit);
		if (schema.prefixItems || Array.isArray(schema.items)) return value;
		return [schema.items && typeof schema.items === "object" ? descend(value, schema.items) : value];
	}
	const target = typeof type === "string" ? conversions.get(type) : undefined;
	return target ? Value.Convert(target, value) : value;
}
function coerceTypes(value: unknown, schema: Schema, root: SchemaNode): unknown {
	if (!schema || typeof schema !== "object") return value;
	if (typeof schema.$id === "string") root = schema;
	const visit: Transform = (input, target) => coerceTypes(input, target, root);
	if (Array.isArray(schema.allOf)) for (const branch of schema.allOf) value = visit(value, branch);
	for (const branches of [schema.anyOf, schema.oneOf]) {
		if (!Array.isArray(branches) || branches.some((branch) => subValidator(branch, root)?.Check(value))) continue;
		for (const branch of branches) {
			const next = visit(structuredClone(value), branch);
			if (subValidator(branch, root)?.Check(next)) {
				value = next;
				break;
			}
		}
	}
	const types = typeof schema.type === "string" ? [schema.type] : (schema.type ?? []);
	if (!(types.length > 1 && types.some((type) => matches(value, type))))
		for (const type of types) {
			const next = primitive(value, type);
			if (next !== value) {
				value = next;
				break;
			}
		}
	if (types.includes("array") && Array.isArray(value)) return arrayMembers(value, schema, visit);
	return types.includes("object") ? objectMembers(value, schema, visit) : value;
}
function omitOptionalNulls(value: unknown, schema: Schema, root: SchemaNode): unknown {
	if (!schema || typeof schema !== "object") return value;
	if (typeof schema.$id === "string") root = schema;
	const visit: Transform = (input, target) => omitOptionalNulls(input, target, root);
	if (Array.isArray(value)) return arrayMembers(value, schema, visit);
	if (typeof value !== "object" || value === null) return value;
	const object = value as Record<string, unknown>;
	for (const [key, property] of Object.entries(schema.properties ?? {}))
		if (
			Object.hasOwn(object, key) &&
			object[key] === null &&
			!schema.required?.includes(key) &&
			(typeof property !== "object" || typeof property.$ref !== "string") &&
			subValidator(property, root)?.Check(null) === false
		)
			delete object[key];
	return objectMembers(value, schema, visit);
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
	const input = structuredClone(call.arguments),
		schema = tool.parameters as SchemaNode;
	omitOptionalNulls(input, schema, schema);
	const args = coerceTypes(convert(input, schema, schema), schema, schema);
	const compiled = validator(tool.parameters, schema);
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
