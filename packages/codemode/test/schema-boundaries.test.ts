import { expect, test } from "vitest";
import {
	parseCodemodeSource,
	renderDeclarations,
	renderToolSample,
	schemaToType,
	toCodemodeIdentifier,
	type CodemodeJsonSchema,
} from "../src/index.ts";

test("schema declarations preserve empty unions, legacy tuples, unconstrained arrays and unusual property names", () => {
	for (const [schema, expected] of [
		[{ enum: [] }, "never"],
		[{ allOf: [true, {}] }, "unknown"],
		[{ type: "array" }, "unknown[]"],
		[{ type: "array", items: [{ type: "number" }, { const: "last" }] }, '[number, "last"]'],
		[{ type: "unsupported" }, "unknown"],
		[{ properties: { "file-name": { type: "string" } }, required: ["file-name"] }, '{ "file-name": string; }'],
		[{ const: undefined }, "unknown"],
		[
			{ properties: { enabled: true, disabled: false }, additionalProperties: false },
			"{ disabled?: never; enabled?: unknown; }",
		],
	] satisfies [CodemodeJsonSchema, string][])
		expect(schemaToType(schema)).toBe(expected);
	expect(toCodemodeIdentifier("")).toBe("_");
	expect(parseCodemodeSource('// @options: {"max_output_tokens":0}\nreturn true;')).toEqual({
		code: "\nreturn true;",
		options: { maxOutputTokens: 0 },
	});
});

test("schema constraint comments retain exclusive bounds, flags and typed dictionaries", () => {
	const rendered = schemaToType({
		type: "object",
		properties: {
			count: {
				type: ["integer", "null"],
				minimum: 1,
				exclusiveMinimum: true,
				maximum: 8,
				exclusiveMaximum: true,
				deprecated: true,
			},
			items: { type: "array", items: { type: "boolean" }, uniqueItems: true },
		},
		additionalProperties: { type: "string" },
	});
	expect(rendered).toBe(
		"{\n  // @integer @exclusiveMinimum 1 @exclusiveMaximum 8 @deprecated\n  count?: number | null;\n  // @uniqueItems\n  items?: Array<boolean>;\n  [key: string]: string;\n}",
	);
});

test("declarations preserve multiline descriptions and group global functions in their namespace", () => {
	expect(
		renderDeclarations({
			tools: [{ name: "fetch", description: "First line\n\nLast line", execute() {} }],
			globals: [
				{ name: "ping", execute() {} },
				{ name: "files.read", inputSchema: { type: "string" }, outputSchema: { type: "string" }, execute() {} },
				{ name: "files.exists", inputSchema: { type: "string" }, outputSchema: { type: "boolean" }, execute() {} },
			],
		}),
	).toBe(
		"declare const tools: {\n  /**\n   * First line\n   *\n   * Last line\n   */\n  fetch(args: unknown): Promise<unknown>;\n};\n\ndeclare function ping(args: unknown): Promise<unknown>;\n\ndeclare const files: {\n  read(args: string): Promise<string>;\n  exists(args: string): Promise<boolean>;\n};",
	);
	expect(renderDeclarations({})).toBe("");
	expect(renderToolSample({ name: "empty" })).toBe(
		"\n\ncodemode tool declaration:\n```ts\ndeclare const tools: { empty(args: unknown): Promise<unknown>; };\n```",
	);
});
