import { toCodemodeIdentifier } from "./identifier.ts";
import type { CodemodeJsonSchema, CodemodeTool } from "./types.ts";
export { toCodemodeIdentifier };
export const DEFAULT_INPUT_SCHEMA_MAX_CHARS = 16000;
export interface RenderDeclarationsOptions {
	tools?: readonly CodemodeTool[];
	globals?: readonly CodemodeTool[];
}
const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const lineBreak = /[\r\n\u2028\u2029]/g;
const keywords = [
	"minimum",
	"exclusiveMinimum",
	"maximum",
	"exclusiveMaximum",
	"multipleOf",
	"minLength",
	"maxLength",
	"pattern",
	"format",
	"minItems",
	"maxItems",
];
const lower = new Set(["minimum", "exclusiveMinimum", "minLength", "minItems"]);
const upper = new Set(["maximum", "exclusiveMaximum", "maxLength", "maxItems"]);
function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function union(values: string[]): string {
	return values.includes("unknown") ? "unknown" : [...new Set(values)].join(" | ") || "never";
}
function literal(value: unknown): string {
	return JSON.stringify(value) ?? "unknown";
}
function description(value: unknown): string {
	const text = (value as { description?: unknown } | null | undefined)?.description;
	return typeof text === "string" ? text.trim() : "";
}
function comment(text: string | undefined, pad = ""): string {
	const value = text?.trim();
	if (!value) return "";
	const lines = value.replaceAll("*/", "*\\/").split(/\r?\n/);
	return lines.length === 1
		? `${pad}/** ${lines[0]} */\n`
		: `${pad}/**\n${lines.map((line) => `${pad} *${line ? ` ${line}` : ""}`).join("\n")}\n${pad} */\n`;
}
function tags(value: unknown): string {
	if (!object(value)) return "";
	const alternatives = Array.isArray(value.anyOf) ? value.anyOf : value.oneOf;
	const branches = Array.isArray(alternatives) ? alternatives.filter((v) => !object(v) || v.type !== "null") : [];
	const combined = branches.length === 1 && object(branches[0]) ? [value, branches[0]] : [value];
	const constraints = combined.map(
		(v): Record<string, unknown> => ({
			...v,
			...(v.exclusiveMinimum === true ? { minimum: undefined, exclusiveMinimum: v.minimum } : {}),
			...(v.exclusiveMaximum === true ? { maximum: undefined, exclusiveMaximum: v.maximum } : {}),
		}),
	);
	const output: string[] = [];
	if (constraints.some((v) => v.type === "integer" || (Array.isArray(v.type) && v.type.includes("integer"))))
		output.push("@integer");
	for (const key of keywords) {
		const all = constraints.map((v) => v[key]);
		if (lower.has(key) || upper.has(key)) {
			const nums = all.filter((v): v is number => typeof v === "number");
			if (nums.length) output.push(`@${key} ${lower.has(key) ? Math.max(...nums) : Math.min(...nums)}`);
		} else
			for (const v of new Set(all)) if (typeof v === "number" || typeof v === "string") output.push(`@${key} ${v}`);
	}
	if (constraints.some((v) => v.uniqueItems === true)) output.push("@uniqueItems");
	if (value.default !== undefined && value.default !== null) output.push(`@default ${literal(value.default)}`);
	if (value.deprecated === true) output.push("@deprecated");
	return output
		.filter((v) => v.length <= 80)
		.map((v) => v.replace(lineBreak, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`))
		.join(" ");
}
type SchemaRender = { root: unknown; path: Set<string>; remaining: number; tags: boolean };
function reference(pointer: string, root: unknown): unknown {
	if (pointer !== "#" && !pointer.startsWith("#/")) return undefined;
	let value = root;
	for (const segment of pointer.slice(2).split("/").filter(Boolean)) {
		const key = decodeURIComponent(segment).replaceAll("~1", "/").replaceAll("~0", "~");
		if (!object(value) || !(key in value)) return undefined;
		value = value[key];
	}
	return typeof value === "boolean" || object(value) ? value : undefined;
}
function render(value: unknown, ctx: SchemaRender): string {
	if (value === false) return "never";
	if (!object(value)) return "unknown";
	if (typeof value.$ref === "string") {
		if (ctx.path.has(value.$ref) || ctx.remaining === 0) return "unknown";
		const target = reference(value.$ref, ctx.root);
		if (target === undefined) return "unknown";
		ctx.remaining--;
		ctx.path.add(value.$ref);
		try {
			return render(target, ctx);
		} finally {
			ctx.path.delete(value.$ref);
		}
	}
	if ("const" in value) return literal(value.const);
	if (Array.isArray(value.enum)) return union(value.enum.map(literal));
	const alternatives = Array.isArray(value.anyOf) ? value.anyOf : value.oneOf;
	if (Array.isArray(alternatives)) return union(alternatives.map((v) => render(v, ctx)));
	if (Array.isArray(value.allOf)) {
		const parts = value.allOf.map((v) => render(v, ctx)).filter((v) => v !== "unknown");
		return parts.map((v) => (v.includes(" | ") ? `(${v})` : v)).join(" & ") || "unknown";
	}
	const type = value.type;
	if (Array.isArray(type)) return union(type.map((type) => render({ ...value, type }, ctx)));
	switch (type) {
		case "number":
		case "integer":
			return "number";
		case "string":
		case "boolean":
		case "null":
			return type;
		case "array":
			return array(value, ctx);
		case "object":
			return properties(value, ctx);
		case undefined:
			if ("properties" in value || "required" in value || "additionalProperties" in value)
				return properties(value, ctx);
			if ("items" in value || "prefixItems" in value) return array(value, ctx);
			return "unknown";
		default:
			return "unknown";
	}
}
function array(schema: Record<string, unknown>, ctx: SchemaRender): string {
	if (schema.items !== undefined && !Array.isArray(schema.items)) return `Array<${render(schema.items, ctx)}>`;
	const tuple = Array.isArray(schema.prefixItems)
		? schema.prefixItems
		: Array.isArray(schema.items)
			? schema.items
			: [];
	return tuple.length ? `[${tuple.map((v) => render(v, ctx)).join(", ")}]` : "unknown[]";
}
function properties(schema: Record<string, unknown>, ctx: SchemaRender): string {
	const props = object(schema.properties) ? schema.properties : {};
	const required = new Set(Array.isArray(schema.required) ? schema.required : []);
	const names = Object.keys(props).sort();
	const members = names.map(
		(name) =>
			`${identifier.test(name) ? name : JSON.stringify(name)}${required.has(name) ? "" : "?"}: ${render(props[name], ctx)};`,
	);
	if (schema.additionalProperties !== undefined && schema.additionalProperties !== false)
		members.push(`[key: string]: ${render(schema.additionalProperties, ctx)};`);
	else if (schema.additionalProperties === undefined && !names.length) members.push("[key: string]: unknown;");
	if (!members.length) return "{}";
	const comments = names.map((name) => {
		const lines = description(props[name])
			.split(lineBreak)
			.map((v) => v.trim())
			.filter(Boolean);
		const annotation = ctx.tags ? tags(props[name]) : "";
		return annotation ? [...lines, annotation] : lines;
	});
	if (!comments.some((v) => v.length)) return `{ ${members.join(" ")} }`;
	const rows = ["{"];
	for (let i = 0; i < names.length; i++) {
		rows.push(...comments[i].map((line) => `  // ${line}`));
		rows.push(`  ${members[i].replaceAll("\n", "\n  ")}`);
	}
	rows.push(...members.slice(names.length).map((line) => `  ${line}`), "}");
	return rows.join("\n");
}
export function schemaToType(schema: CodemodeJsonSchema, options: { maxChars?: number } = {}): string {
	const run = (withTags: boolean) => render(schema, { root: schema, path: new Set(), remaining: 32, tags: withTags });
	const text = run(true);
	if (options.maxChars === undefined || text.length <= options.maxChars) return text;
	const shorter = run(false);
	return shorter.length <= options.maxChars ? shorter : "unknown";
}
export function renderToolOutputType(schema: CodemodeJsonSchema | undefined): string {
	return schema === undefined ? "unknown" : schemaToType(schema);
}
export function renderToolSignature(
	tool: Pick<CodemodeTool, "name" | "inputSchema" | "outputSchema">,
	options: { inputMaxChars?: number } = {},
): string {
	const input =
		tool.inputSchema === undefined
			? "unknown"
			: schemaToType(tool.inputSchema, { maxChars: options.inputMaxChars ?? DEFAULT_INPUT_SCHEMA_MAX_CHARS });
	return `${toCodemodeIdentifier(tool.name)}(args: ${input}): Promise<${renderToolOutputType(tool.outputSchema)}>;`;
}
export function renderToolSample(
	tool: Pick<CodemodeTool, "name" | "description" | "inputSchema" | "outputSchema">,
	options: { inputMaxChars?: number } = {},
): string {
	const declaration = `declare const tools: { ${renderToolSignature(tool, options)} };`;
	return `${tool.description?.trim() ?? ""}\n\ncodemode tool declaration:\n\`\`\`ts\n${declaration}\n\`\`\``;
}
export function renderDeclarations(options: RenderDeclarationsOptions): string {
	const sections: string[] = [],
		groups = new Map<string, string[]>();
	const tools = options.tools ?? [];
	if (tools.length)
		sections.push(
			`declare const tools: {\n${tools.map((tool) => `${comment(tool.description, "  ")}  ${renderToolSignature(tool)}`).join("\n")}\n};`,
		);
	for (const global of options.globals ?? []) {
		const dot = global.name.indexOf("."),
			pad = dot < 0 ? "" : "  ";
		const head = dot < 0 ? `declare function ${global.name}` : global.name.slice(dot + 1);
		const signature =
			global.signature ??
			`(args: ${renderToolOutputType(global.inputSchema)}): Promise<${renderToolOutputType(global.outputSchema)}>`;
		const member = `${comment(global.description, pad)}${pad}${head}${signature};`;
		if (dot < 0) sections.push(member);
		else {
			const namespace = global.name.slice(0, dot),
				group = groups.get(namespace) ?? [];
			group.push(member);
			groups.set(namespace, group);
		}
	}
	for (const [namespace, members] of groups) sections.push(`declare const ${namespace}: {\n${members.join("\n")}\n};`);
	return sections.join("\n\n");
}
