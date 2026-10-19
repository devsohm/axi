import type { Tool } from "../types.ts";

class UnsupportedStrictJsonSchemaError extends Error {}
export type UnsupportedStrictSchemaKeywordCheck = (key: string, value: unknown) => boolean;
const forbidden = [
	"$ref",
	"$defs",
	"definitions",
	"allOf",
	"oneOf",
	"patternProperties",
	"dependentSchemas",
	"dependencies",
	"unevaluatedProperties",
	"propertyNames",
	"contains",
	"prefixItems",
	"not",
	"if",
	"then",
	"else",
];
function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function structured(schema: unknown): boolean {
	if (!object(schema)) return false;
	const types = typeof schema.type === "string" ? [schema.type] : Array.isArray(schema.type) ? schema.type : [];
	return (
		types.includes("object") || types.includes("array") || schema.properties !== undefined || schema.items !== undefined
	);
}
function nullable(schema: unknown): boolean {
	return (
		object(schema) &&
		(schema.type === "null" ||
			(Array.isArray(schema.type) && schema.type.includes("null")) ||
			schema.const === null ||
			(Array.isArray(schema.enum) && schema.enum.includes(null)) ||
			(Array.isArray(schema.anyOf) && schema.anyOf.some((branch: unknown) => nullable(branch))))
	);
}
function strict(schema: unknown, unsupported?: UnsupportedStrictSchemaKeywordCheck): void {
	const reject = (message: string): never => {
		throw new UnsupportedStrictJsonSchemaError(message);
	};
	if (!object(schema)) throw new UnsupportedStrictJsonSchemaError("boolean schemas are unsupported");
	for (const key of forbidden) if (schema[key] !== undefined) reject(`${key} schemas are unsupported`);
	if (unsupported)
		for (const [key, value] of Object.entries(schema))
			if (unsupported(key, value)) reject(`${key}: ${JSON.stringify(value)} is unsupported`);
	if (schema.anyOf !== undefined) {
		if (!Array.isArray(schema.anyOf) || !schema.anyOf.length) reject("anyOf must contain at least one schema");
		for (const branch of schema.anyOf as unknown[]) {
			if (structured(branch)) reject("object and array unions are unsupported");
			strict(branch, unsupported);
		}
	}
	if (schema.items !== undefined) {
		if (Array.isArray(schema.items)) reject("tuple schemas are unsupported");
		strict(schema.items, unsupported);
	}
	if (schema.properties !== undefined && schema.type !== "object") reject("properties require type object");
	if (schema.type !== "object") return;
	if (schema.additionalProperties !== undefined && schema.additionalProperties !== false)
		reject("schema-valued or true additionalProperties is unsupported");
	const properties = schema.properties === undefined ? {} : schema.properties;
	if (!object(properties)) throw new UnsupportedStrictJsonSchemaError("object properties must be a schema map");
	const required = schema.required === undefined ? [] : schema.required;
	if (!Array.isArray(required) || required.some((key: unknown) => typeof key !== "string"))
		reject("object required must be a string array");
	const names = Object.keys(properties);
	const requiredNames = new Set(required as string[]);
	if ([...requiredNames].some((key) => !names.includes(key))) reject("required contains an unknown property");
	for (const [key, property] of Object.entries(properties)) {
		strict(property, unsupported);
		if (!requiredNames.has(key) && !nullable(property)) properties[key] = { anyOf: [property, { type: "null" }] };
	}
	schema.required = names;
	schema.additionalProperties = false;
}
export function makeStrictJsonSchema(
	schema: Tool["parameters"],
	unsupported?: UnsupportedStrictSchemaKeywordCheck,
): Record<string, unknown> {
	const copy: unknown = structuredClone(schema);
	if (!object(copy)) throw new UnsupportedStrictJsonSchemaError("root schema must have type object");
	strict(copy, unsupported);
	if (copy.type !== "object") throw new UnsupportedStrictJsonSchemaError("root schema must have type object");
	return copy;
}
export function getJsonSchemaToolParameters(tool: Tool, strictMode: boolean | undefined): Tool["parameters"] {
	return strictMode === true ? makeStrictJsonSchema(tool.parameters) : tool.parameters;
}
export interface GrammarConstrainedSampling {
	format: "lark" | "regex";
	definition: string;
	inputProperty: string;
}
export interface GrammarToolInputJsonBuffer {
	input: string;
	started: boolean;
	closed: boolean;
}
export function getGrammarToolInput(
	toolName: string,
	arguments_: Record<string, unknown>,
	inputProperty: string,
): string {
	const value = arguments_[inputProperty];
	if (typeof value !== "string")
		throw new Error(`Grammar tool call "${toolName}" requires argument "${inputProperty}" to be a string.`);
	return value;
}
export function appendGrammarToolInputJsonDelta(
	buffer: GrammarToolInputJsonBuffer,
	inputProperty: string,
	nextInput: string,
	close: boolean,
): string | undefined {
	if (buffer.closed) {
		if (close && nextInput === buffer.input) return undefined;
		throw new Error(`grammar tool input for property "${inputProperty}" changed after it was closed`);
	}
	if (!nextInput.startsWith(buffer.input))
		throw new Error(`grammar tool input for property "${inputProperty}" changed non-monotonically`);
	const suffix = nextInput.slice(buffer.input.length);
	if (!close && !suffix.length) return undefined;
	const prefix = buffer.started ? "" : `{${JSON.stringify(inputProperty)}:"`;
	buffer.started = true;
	buffer.input = nextInput;
	if (close) buffer.closed = true;
	return prefix + JSON.stringify(suffix).slice(1, -1) + (close ? '"}' : "");
}
export function resolveJsonSchemaStrictSampling(
	tool: Tool,
	supportsStrictMode: boolean,
	unsupported?: UnsupportedStrictSchemaKeywordCheck,
): boolean | undefined {
	const config = tool.constrainedSampling;
	if (!config || config.type !== "json_schema") return undefined;
	if (supportsStrictMode) {
		try {
			makeStrictJsonSchema(tool.parameters, unsupported);
			return true;
		} catch (error) {
			if (!(error instanceof UnsupportedStrictJsonSchemaError)) throw error;
			if (config.strict !== "require") return undefined;
			throw new Error(`Tool "${tool.name}" requires JSON-schema constrained sampling, but ${error.message}.`);
		}
	}
	if (config.strict === "require")
		throw new Error(`Tool "${tool.name}" requires JSON-schema constrained sampling, but strict tools are unsupported.`);
	return undefined;
}
export function resolveGrammarConstrainedSampling(
	tool: Tool,
	supportsOpenAIGrammarTools: boolean,
): GrammarConstrainedSampling | undefined {
	const config = tool.constrainedSampling;
	if (!config || config.type !== "grammar" || !supportsOpenAIGrammarTools) return undefined;
	const variants = config.variants;
	let format: GrammarConstrainedSampling["format"], definition: string;
	if (typeof variants.openai_lark === "string" && variants.openai_lark.trim()) {
		format = "lark";
		definition = variants.openai_lark;
	} else if (typeof variants.openai_regex === "string" && variants.openai_regex.trim()) {
		format = "regex";
		definition = variants.openai_regex;
	} else
		throw new Error(
			`Tool "${tool.name}" cannot use grammar constrained sampling: no supported grammar variant was provided.`,
		);
	try {
		const schema: unknown = tool.parameters;
		if (!object(schema) || schema.type !== "object")
			throw new Error("grammar constrained sampling requires an object parameter schema");
		if (!Array.isArray(schema.required) || schema.required.length !== 1 || typeof schema.required[0] !== "string")
			throw new Error("grammar constrained sampling requires exactly one required string property");
		const inputProperty = schema.required[0];
		if (!object(schema.properties) || !schema.properties[inputProperty])
			throw new Error(`grammar constrained sampling requires a properties entry for ${inputProperty}`);
		const property = schema.properties[inputProperty];
		if (!object(property) || property.type !== "string")
			throw new Error(`grammar constrained sampling property ${inputProperty} must have type string`);
		return { format, definition, inputProperty };
	} catch (error) {
		throw new Error(
			`Tool "${tool.name}" cannot use grammar constrained sampling: ${error instanceof Error ? error.message : String(error)}.`,
		);
	}
}
export function createGrammarToolInputProperties(
	tools: Tool[] | undefined,
	supportsOpenAIGrammarTools: boolean,
): ReadonlyMap<string, string> {
	const entries = new Map<string, string>();
	for (const tool of tools ?? []) {
		const grammar = resolveGrammarConstrainedSampling(tool, supportsOpenAIGrammarTools);
		if (grammar) entries.set(tool.name, grammar.inputProperty);
	}
	return entries;
}
