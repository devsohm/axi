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
	if?: Schema;
	then?: Schema;
	else?: Schema;
	const?: unknown;
	enum?: unknown[];
	$ref?: string;
	$id?: string;
}
type CheckedSchema = Pick<ReturnType<typeof Compile>, "Check" | "Errors">;
const cache = new WeakMap<
	object,
	{
		references: Record<string, Tool["parameters"]>;
		validators: WeakMap<object, CheckedSchema>;
	}
>();
const conversions = new Map<string, Tool["parameters"]>([
	["string", Type.String()],
	["number", Type.Number()],
	["integer", Type.Integer()],
	["boolean", Type.Boolean()],
	["bigint", Type.BigInt()],
	["undefined", Type.Undefined()],
	["null", Type.Null()],
	["array", Type.Array(Type.Unknown())],
]);
function resolve(schema: SchemaNode, root: SchemaNode): Schema {
	const visited = new Set<Schema>();
	while (typeof schema.$ref === "string" && !visited.has(schema)) {
		visited.add(schema);
		let target: unknown;
		if (schema.$ref === "#" || schema.$ref.startsWith("#/")) {
			try {
				target = Value.Pointer.Get(root, decodeURIComponent(schema.$ref.slice(1)));
			} catch {
				break;
			}
		} else {
			const pending: unknown[] = [root];
			while (pending.length) {
				const node = pending.pop();
				if (Array.isArray(node)) pending.push(...node);
				else if (Type.IsSchema(node)) {
					if ("$id" in node && node.$id === schema.$ref) {
						target = node;
						break;
					}
					for (const [key, child] of Object.entries(node)) if (key !== "const" && key !== "enum") pending.push(child);
				}
			}
		}
		if (typeof target === "boolean") return target;
		if (!Type.IsSchema(target)) break;
		schema = target;
	}
	return schema;
}
function schemaForValidation(schema: SchemaNode, root: SchemaNode): Tool["parameters"] {
	const scope = typeof schema.$id === "string" ? schema : root;
	if (typeof schema.$ref === "string" && resolve(schema, scope) === schema) return Type.Never();
	const copy: Record<string, unknown> = { ...schema };
	for (const keyword of ["pattern", "patternProperties"]) {
		const patterns = keyword === "pattern" ? [copy.pattern] : Object.keys(schema.patternProperties ?? {});
		for (const pattern of patterns)
			if (typeof pattern === "string") {
				try {
					new RegExp(pattern, "u");
				} catch {
					new RegExp(pattern);
				}
			}
	}
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
function validator(schema: Tool["parameters"], root: SchemaNode): CheckedSchema {
	let owner = cache.get(root);
	if (!owner) {
		const references: Record<string, Tool["parameters"]> = Object.create(null);
		const pending: unknown[] = [root];
		while (pending.length) {
			const current = pending.pop();
			if (Array.isArray(current)) pending.push(...current);
			else if (Type.IsSchema(current)) {
				if ("$ref" in current && typeof current.$ref === "string") {
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
	let compiled: CheckedSchema;
	try {
		compiled = schema === root ? Compile(normalized) : Compile(owner.references, normalized);
	} catch (error) {
		if (!(error instanceof RangeError)) throw error;
		// Large enum expressions can exceed the compiler's stack; the interpreter checks the same schema.
		const references = owner.references;
		compiled = {
			Check: (value): value is unknown => Value.Check(references, normalized, value),
			Errors: (value) => Value.Errors(references, normalized, value),
		};
	}
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
	let result = value;
	for (let index = 0; index < value.length; index++) {
		const item = Array.isArray(schema.items) ? schema.items[index] : (schema.prefixItems?.[index] ?? schema.items);
		if (item && typeof item === "object") {
			const next = transform(value[index], item);
			if (!Object.is(next, result[index])) {
				if (result === value) result = value.slice();
				result[index] = next;
			}
		}
	}
	return result;
}
function objectMembers(value: unknown, schema: SchemaNode, transform: Transform): unknown {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
	let object = value as Record<string, unknown>;
	const set = (key: string, next: unknown) => {
		if (Object.is(object[key], next)) return;
		if (object === value) object = Object.assign(Object.create(Object.getPrototypeOf(object)), object);
		Object.defineProperty(object, key, { value: next, enumerable: true, writable: true, configurable: true });
	};
	for (const [key, property] of Object.entries(schema.properties ?? {}))
		if (Object.hasOwn(object, key) && object[key] !== undefined) set(key, transform(object[key], property));
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
					set(key, transform(object[key], property));
				}
			if (!matched && schema.additionalProperties && typeof schema.additionalProperties === "object")
				set(key, transform(object[key], schema.additionalProperties));
		}
	return object;
}
function literal(value: unknown, expected: unknown): unknown {
	const target = conversions.get(typeof expected);
	if (!target) return value;
	const next = Value.Convert(target, value);
	return next === expected ? next : value;
}
type Conversion = { state: "active" } | { state: "complete"; value: unknown };
interface ConversionContext {
	values: Map<Schema, Map<unknown, Conversion>>;
	cycles: number;
}
function convert(
	value: unknown,
	schema: Schema,
	root: SchemaNode,
	context: ConversionContext = { values: new Map(), cycles: 0 },
): unknown {
	if (typeof schema === "object" && typeof schema.$id === "string") root = schema;
	let values = context.values.get(schema);
	if (!values) context.values.set(schema, (values = new Map()));
	const previous = values.get(value);
	if (previous?.state === "complete") return previous.value;
	if (previous?.state === "active") {
		context.cycles++;
		return value;
	}
	values.set(value, { state: "active" });
	const cycles = context.cycles;
	try {
		const result = convertNode(value, schema, root, (input, target) => convert(input, target, root, context));
		// A result reached through an active cycle depends on that call stack and must not enter the cache.
		if (context.cycles === cycles) values.set(value, { state: "complete", value: result });
		return result;
	} finally {
		if (values.get(value)?.state === "active") values.delete(value);
	}
}
function convertNode(value: unknown, schema: Schema, root: SchemaNode, descend: Transform): unknown {
	if (!schema || typeof schema !== "object") return value;
	const visit = descend;
	if (typeof schema.$ref === "string") {
		const target = resolve(schema, root);
		return target === schema ? value : descend(value, target);
	}
	if (Object.hasOwn(schema, "const")) return literal(value, schema.const);
	if (Array.isArray(schema.enum)) {
		if (schema.enum.includes(value)) return value;
		for (const member of schema.enum) {
			const next = literal(value, member);
			if (next === member && subValidator(schema, root)?.Check(next)) return next;
		}
		return value;
	}
	const branches = schema.anyOf ?? schema.oneOf;
	if (Array.isArray(branches)) {
		if (branches.some((branch) => subValidator(branch, root)?.Check(value))) return objectMembers(value, schema, visit);
		for (const branch of branches) {
			const next = objectMembers(visit(value, branch), schema, visit);
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
			const next = visit(value, branch);
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
function location(pointer: string): string {
	return pointer
		? pointer
				.slice(1)
				.split("/")
				.map((key) => key.replaceAll("~1", "/").replaceAll("~0", "~"))
				.join(".")
		: "root";
}
function receivedType(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	if (value instanceof Uint8Array) return "bytes";
	if (typeof value === "number")
		return Number.isInteger(value) ? "integer" : Number.isFinite(value) ? "number" : String(value);
	return typeof value;
}
function diagnostic(error: TLocalizedValidationError, value: unknown, root: SchemaNode): string[] {
	if (error.keyword === "required")
		return error.params.requiredProperties.map((property) => {
			const pointer = `${error.instancePath}/${property.replaceAll("~", "~0").replaceAll("/", "~1")}`;
			return `  - ${location(pointer)}: missing`;
		});
	let message = error.message;
	if (error.keyword === "not" || error.keyword === "boolean") {
		const schema = errorSchema(root, error.schemaPath);
		if (typeof schema === "object" && schema !== null && "$ref" in schema && typeof schema.$ref === "string")
			message = `unresolved reference ${schema.$ref}`;
		else if (error.keyword === "not") message = "must not match the schema in not";
	}
	if (error.keyword === "type")
		message = `expected ${[error.params.type].flat().join(" or ")}, got ${receivedType(Value.Pointer.Get(value, error.instancePath))}`;
	else if (error.keyword === "boolean" && message === error.message)
		message = error.schemaPath.endsWith("/additionalProperties") ? "unknown field" : "no value is allowed here";
	else if (
		["minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties"].includes(error.keyword) &&
		"limit" in error.params
	) {
		const unit = error.keyword.endsWith("Length")
			? "characters"
			: error.keyword.endsWith("Items")
				? "items"
				: "properties";
		message = `expected at ${error.keyword.startsWith("min") ? "least" : "most"} ${error.params.limit} ${unit}`;
	} else if (
		["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"].includes(error.keyword) &&
		"comparison" in error.params &&
		"limit" in error.params
	)
		message = `expected ${error.params.comparison} ${error.params.limit}`;
	else if (error.keyword === "pattern") message = `expected to match ${error.params.pattern}`;
	else if (error.keyword === "format") message = `expected format ${error.params.format}`;
	else if (error.keyword === "dependentRequired" || error.keyword === "dependencies") {
		const input = Value.Pointer.Get(value, error.instancePath);
		return error.params.dependencies
			.filter((key) => typeof input !== "object" || input === null || !Object.hasOwn(input, key))
			.map(
				(key) =>
					`  - ${location(`${error.instancePath}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`)}: required when ${error.params.property} is present`,
			);
	} else if (error.keyword === "propertyNames")
		return error.params.propertyNames.map(
			(key) =>
				`  - ${location(`${error.instancePath}/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}`)}: invalid property name`,
		);
	else if (error.keyword === "unevaluatedProperties")
		return error.params.unevaluatedProperties.map(
			(key) =>
				`  - ${location(`${error.instancePath}/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}`)}: unknown field`,
		);
	else if (error.keyword === "unevaluatedItems")
		return error.params.unevaluatedItems.map(
			(index) => `  - ${location(`${error.instancePath}/${index}`)}: unexpected item`,
		);
	else if (error.keyword === "contains") {
		const min = error.params.minContains,
			max = error.params.maxContains;
		if (max === undefined) message = `expected at least ${min} matching ${min === 1 ? "item" : "items"}`;
		else if (min === 0) message = `expected at most ${max} matching ${max === 1 ? "item" : "items"}`;
		else message = `expected between ${min} and ${max} matching items`;
	} else if (error.keyword === "multipleOf") message = `expected a multiple of ${error.params.multipleOf}`;
	else if (error.keyword === "uniqueItems") message = "expected unique items";
	else if (error.keyword === "const") message = `expected ${JSON.stringify(error.params.allowedValue)}`;
	else if (error.keyword === "enum") {
		const allowed = error.params.allowedValues,
			json = JSON.stringify(allowed.slice(0, 20));
		message = `expected one of ${allowed.length <= 20 ? json : `${json.slice(0, -1)}, ... and ${allowed.length - 20} more]`}`;
	}
	return [`  - ${location(error.instancePath)}: ${message}`];
}

const errorKeywords = [
	"type",
	"enum",
	"const",
	"minLength",
	"maxLength",
	"pattern",
	"format",
	"minimum",
	"maximum",
	"exclusiveMinimum",
	"exclusiveMaximum",
	"multipleOf",
	"required",
	"properties",
	"patternProperties",
	"additionalProperties",
	"minProperties",
	"maxProperties",
	"items",
	"prefixItems",
	"additionalItems",
	"minItems",
	"maxItems",
	"uniqueItems",
	"contains",
	"allOf",
	"anyOf",
	"oneOf",
	"not",
	"if",
	"then",
	"else",
	"$ref",
	"unevaluatedProperties",
	"unevaluatedItems",
];
function errorSchema(root: SchemaNode, pointer: string): unknown {
	let node: unknown = root,
		scope = root;
	const keys =
		pointer === "#"
			? []
			: pointer
					.slice(2)
					.split("/")
					.map((key) => key.replaceAll("~1", "/").replaceAll("~0", "~"));
	for (const key of [...keys, undefined]) {
		if (typeof node === "object" && node !== null && !Array.isArray(node)) {
			const schema = node as SchemaNode;
			if (typeof schema.$id === "string") scope = schema;
			if (typeof schema.$ref === "string") node = resolve(schema, scope);
		}
		if (key === undefined) return node;
		node = typeof node === "object" && node !== null ? Reflect.get(node, key) : undefined;
	}
}
function errorPosition(error: TLocalizedValidationError, schema: SchemaNode): number[] {
	const segments =
		error.schemaPath === "#"
			? []
			: error.schemaPath
					.slice(2)
					.split("/")
					.map((key) => key.replaceAll("~1", "/").replaceAll("~0", "~"));
	let fields = false;
	return [...segments, error.keyword].map((key, index) => {
		const prefix = segments.slice(0, index).map((segment) => segment.replaceAll("~", "~0").replaceAll("/", "~1"));
		const node = errorSchema(schema, index ? `#/${prefix.join("/")}` : "#");
		const keys = typeof node === "object" && node !== null ? Object.keys(node) : [];
		const position = Array.isArray(node) ? Number(key) : fields ? keys.indexOf(key) : errorKeywords.indexOf(key);
		fields = ["properties", "patternProperties", "$defs", "definitions"].includes(key);
		return position < 0 ? errorKeywords.length : position;
	});
}
function comparePosition(a: number[], b: number[]): number {
	for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
	return a.length - b.length;
}
function unionTag(
	branches: Schema[],
	input: unknown,
	root: SchemaNode,
): { key: string; values: unknown[]; index: number } | undefined {
	if (typeof input !== "object" || input === null || Array.isArray(input)) return;
	const members = branches.map((branch) => (typeof branch === "object" ? resolve(branch, root) : branch));
	const first = members[0];
	if (typeof first !== "object") return;
	for (const key of Object.keys(first.properties ?? {})) {
		const values = members.map((member) => {
			const field = typeof member === "object" ? member.properties?.[key] : undefined;
			return typeof field === "object" && Object.hasOwn(field, "const") ? field.const : undefined;
		});
		if (
			values.some((value) => value === undefined || (value !== null && typeof value === "object")) ||
			new Set(values).size !== values.length
		)
			continue;
		return { key, values, index: values.indexOf(Reflect.get(input, key)) };
	}
}
function failures(
	value: unknown,
	schema: Schema,
	root: SchemaNode,
	memo = new Map<Schema, Map<unknown, TLocalizedValidationError[]>>(),
): TLocalizedValidationError[] {
	if (typeof schema === "object" && typeof schema.$id === "string") root = schema;
	let values = memo.get(schema);
	if (!values) memo.set(schema, (values = new Map()));
	const old = values.get(value);
	if (old) return old;
	if (typeof schema === "boolean") return Value.Errors(schema, value);
	const shallow: Record<string, unknown> = { ...schema };
	for (const key of ["anyOf", "oneOf", "allOf", "if", "then", "else"]) delete shallow[key];
	for (const key of ["properties", "patternProperties"]) {
		const fields = shallow[key];
		if (Type.IsSchema(fields)) shallow[key] = Object.fromEntries(Object.keys(fields).map((key) => [key, true]));
	}
	for (const key of ["items", "prefixItems", "additionalItems", "additionalProperties"]) {
		if (Array.isArray(shallow[key])) shallow[key] = shallow[key].map(() => true);
		else if (Type.IsSchema(shallow[key]) || (key === "items" && typeof shallow[key] === "boolean")) shallow[key] = true;
	}
	const target = typeof schema.$ref === "string" ? resolve(schema, root) : schema;
	if (target !== schema) delete shallow.$ref;
	const errors = Value.Errors(cache.get(root)?.references ?? {}, schemaForValidation(shallow, root), value);
	const append = (child: Schema, input: unknown, schemaPath: string, instancePath = "") => {
		errors.push(
			...failures(input, child, root, memo).map((error) => ({
				...error,
				schemaPath: schemaPath + error.schemaPath.slice(1),
				instancePath: instancePath + error.instancePath,
			})),
		);
	};
	if (target !== schema) append(target, value, "#");
	if (typeof value === "object" && value !== null && !Array.isArray(value)) {
		const fields = schema.properties ?? {};
		for (const key of Object.keys(value)) {
			const path = key.replaceAll("~", "~0").replaceAll("/", "~1"),
				input: unknown = Reflect.get(value, key);
			if (input === undefined && !schema.required?.includes(key)) continue;
			let matched = Object.hasOwn(fields, key);
			if (matched) append(fields[key], input, `#/properties/${path}`, `/${path}`);
			for (const [pattern, child] of Object.entries(schema.patternProperties ?? {}))
				if (new RegExp(pattern).test(key)) {
					matched = true;
					append(
						child,
						input,
						`#/patternProperties/${pattern.replaceAll("~", "~0").replaceAll("/", "~1")}`,
						`/${path}`,
					);
				}
			if (!matched && typeof schema.additionalProperties === "object")
				append(schema.additionalProperties, input, "#/additionalProperties", `/${path}`);
		}
	}
	if (Array.isArray(value))
		for (const [index, input] of value.entries()) {
			const tuple = schema.prefixItems ?? (Array.isArray(schema.items) ? schema.items : undefined);
			const child = tuple?.[index] ?? (Array.isArray(schema.items) ? undefined : schema.items);
			if (child !== undefined)
				append(
					child,
					input,
					tuple && index < tuple.length ? `#/${schema.prefixItems ? "prefixItems" : "items"}/${index}` : "#/items",
					`/${index}`,
				);
		}
	for (const [index, child] of (schema.allOf ?? []).entries()) append(child, value, `#/allOf/${index}`);
	for (const keyword of ["anyOf", "oneOf"] as const) {
		const branches = schema[keyword];
		if (!branches) continue;
		const passing = branches.filter((branch) => subValidator(branch, root)?.Check(value)).length;
		if (passing > 0) {
			if (keyword === "oneOf" && passing > 1)
				errors.push(
					...Value.Errors({ oneOf: [true, true] }, value).map((error) => ({
						...error,
						message: "matches more than one alternative",
					})),
				);
			continue;
		}
		const tag = unionTag(branches, value, root);
		if (tag?.index === -1) {
			errors.push(
				...Value.Errors({ enum: tag.values }, Reflect.get(value as object, tag.key)).map((error) => ({
					...error,
					instancePath: `/${tag.key.replaceAll("~", "~0").replaceAll("/", "~1")}`,
				})),
			);
			continue;
		}
		let selected = tag?.index ?? 0,
			score = -1,
			depth = -1;
		if (!tag)
			for (const [index, branch] of branches.entries()) {
				const child = typeof branch === "object" ? resolve(branch, root) : branch;
				const fields = typeof child === "object" ? child.properties : undefined;
				const declared =
					fields && typeof value === "object" && value !== null
						? Object.keys(value).filter((key) => Object.hasOwn(fields, key)).length
						: 0;
				const first = failures(value, branch, root, memo)[0];
				const size = first
					? first.instancePath.length +
						(first.keyword === "required" ? first.params.requiredProperties[0].length + 1 : 0)
					: 0;
				if (declared > score || (declared === score && size > depth)) {
					selected = index;
					score = declared;
					depth = size;
				}
			}
		append(branches[selected], value, `#/${keyword}/${selected}`);
	}
	if ("if" in schema && Type.IsSchema(schema.if)) {
		const keyword = subValidator(schema.if, root)?.Check(value) ? "then" : "else";
		if (keyword in schema && Type.IsSchema(schema[keyword])) append(schema[keyword], value, `#/${keyword}`);
	}
	// Cache only the selected branch's errors, so rejected recursive unions do not expand every alternative.
	let result = errors.filter(
		(error, index) =>
			error.keyword !== "additionalProperties" &&
			!error.schemaPath.endsWith("/propertyNames") &&
			(!["dependentRequired", "dependencies"].includes(error.keyword) ||
				errors.findIndex(
					(other) =>
						other.keyword === error.keyword &&
						other.schemaPath === error.schemaPath &&
						other.instancePath === error.instancePath,
				) === index),
	);
	const localUnevaluated = (error: TLocalizedValidationError) =>
		error.instancePath === "" && (error.keyword === "unevaluatedItems" || error.keyword === "unevaluatedProperties");
	if (result.some(localUnevaluated)) {
		const earlier = result.filter((error) => !localUnevaluated(error));
		result = earlier.length
			? earlier
			: Value.Errors(cache.get(root)?.references ?? {}, schemaForValidation(schema, root), value).filter(
					localUnevaluated,
				);
	}
	values.set(value, result);
	return result;
}
export function validateToolCall(tools: Tool[], call: ToolCall): any {
	const tool = tools.find((tool) => tool.name === call.name);
	if (!tool) throw new Error(`Tool "${call.name}" not found`);
	return validateToolArguments(tool, call);
}
export function validateToolArguments(tool: Tool, call: ToolCall): any {
	if (call.argumentsError) throw new Error(`Invalid arguments for tool "${call.name}": ${call.argumentsError}`);
	const input = ownProperties(structuredClone(call.arguments), null),
		schema = tool.parameters as SchemaNode;
	const args = coerceTypes(convert(omitOptionalNulls(input, schema, schema), schema, schema), schema, schema);
	const compiled = validator(tool.parameters, schema);
	if (compiled.Check(args)) return ownProperties(args, Object.prototype);
	const problems =
		failures(args, schema, schema)
			.toSorted((a, b) => comparePosition(errorPosition(a, schema), errorPosition(b, schema)))
			.flatMap((error) => diagnostic(error, args, schema))
			.join("\n") || "Unknown validation error";
	throw new Error(
		`Validation failed for tool "${call.name}":\n${problems}\n\nReceived arguments:\n${JSON.stringify(call.arguments, null, 2)}`,
	);
}

function ownProperties(value: unknown, prototype: object | null): unknown {
	if (Array.isArray(value)) for (const item of value) ownProperties(item, prototype);
	else if (
		typeof value === "object" &&
		value !== null &&
		(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
	) {
		// Validation must not mistake inherited methods for JSON arguments.
		Object.setPrototypeOf(value, prototype);
		for (const item of Object.values(value)) ownProperties(item, prototype);
	}
	return value;
}
