import { expect, test } from "vitest";
import { parseCodemodeSource, renderDeclarations, renderToolSignature, schemaToType } from "../src/index.ts";

test("source options preserve script line positions and reject ambiguous or invalid limits", () => {
	expect(parseCodemodeSource('  // @options: {"timeout_ms":75,"max_output_tokens":0}\r\nreturn 42;')).toEqual({
		code: "\nreturn 42;",
		options: { timeoutMs: 75, maxOutputTokens: 0 },
	});
	for (const code of ["return 42;", 'text("// @options: {}")', "// @optionsx: {}\nreturn 42;"])
		expect(parseCodemodeSource(code)).toEqual({ code, options: {} });
	for (const value of [
		null,
		[],
		1,
		false,
		{ extra: 1 },
		{ timeout_ms: 0 },
		{ timeout_ms: 2147483648 },
		{ timeout_ms: 1.2 },
		{ timeout_ms: "1" },
		{ max_output_tokens: -1 },
		{ max_output_tokens: 1.2 },
	])
		expect(() => parseCodemodeSource(`// @options: ${JSON.stringify(value)}\nreturn 42;`)).toThrow();
	for (const code of [
		"",
		" \n",
		"// @options: {}",
		"// @options: {}\n \n",
		"// @options: {\nreturn 1;",
		"// @options:\nreturn 1;",
		"return 1;\n// @options: {}",
	])
		expect(() => parseCodemodeSource(code)).toThrow();
});

test("schema declarations represent alternatives, tuples, dictionaries and bounded references", () => {
	const cases = [
		[{ enum: ["on", "off", "on", null] }, '"on" | "off" | null'],
		[{ anyOf: [{ type: "string" }, true] }, "unknown"],
		[{ allOf: [{ type: ["string", "number"] }, { const: 3 }] }, "(string | number) & 3"],
		[{ type: "array", prefixItems: [{ type: "string" }, { type: "boolean" }] }, "[string, boolean]"],
		[{ items: { type: "integer" } }, "Array<number>"],
		[{ type: "object", additionalProperties: { type: "boolean" } }, "{ [key: string]: boolean; }"],
		[{ type: "object", additionalProperties: false }, "{}"],
		[false, "never"],
		[{ $defs: { "a/b": { const: 7 } }, $ref: "#/$defs/a~1b" }, "7"],
		[{ $defs: { loop: { $ref: "#/$defs/loop" } }, $ref: "#/$defs/loop" }, "unknown"],
		[{ $ref: "https://example.test/schema" }, "unknown"],
	] as const;
	for (const [schema, expected] of cases) expect(schemaToType(schema)).toBe(expected);
});

test("schema constraints remain informative within budgets without injecting comment lines", () => {
	const schema = {
		type: "object",
		properties: {
			limit: { anyOf: [{ type: "integer", minimum: 2, maximum: 9 }, { type: "null" }], minimum: 0, maximum: 5 },
		},
	};
	expect(schemaToType(schema)).toBe("{\n  // @integer @minimum 2 @maximum 5\n  limit?: number | null;\n}");
	expect(schemaToType(schema, { maxChars: 40 })).toBe("{ limit?: number | null; }");
	expect(schemaToType(schema, { maxChars: 8 })).toBe("unknown");
	expect(schemaToType({ properties: { value: { type: "string", pattern: "a\nb", default: "\u2028" } } })).toBe(
		'{\n  // @pattern a\\u000ab @default "\\u2028"\n  value?: string;\n}',
	);
});

test("tool and global declarations preserve names, descriptions, output types and signatures", () => {
	expect(
		renderToolSignature({
			name: "read-file",
			inputSchema: { properties: { path: { type: "string" } }, required: ["path"] },
			outputSchema: { type: "string" },
		}),
	).toBe("read_file(args: { path: string; }): Promise<string>;");
	expect(
		renderDeclarations({
			tools: [{ name: "answer", description: "Return */ safely", execute() {}, outputSchema: { type: "integer" } }],
			globals: [
				{ name: "format", description: "Format text", signature: "(text: string): string", execute() {} },
				{ name: "files.exists", inputSchema: { type: "string" }, outputSchema: { type: "boolean" }, execute() {} },
			],
		}),
	).toBe(
		"declare const tools: {\n  /** Return *\\/ safely */\n  answer(args: unknown): Promise<number>;\n};\n\n/** Format text */\ndeclare function format(text: string): string;\n\ndeclare const files: {\n  exists(args: string): Promise<boolean>;\n};",
	);
});
