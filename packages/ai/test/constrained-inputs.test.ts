import { expect, test } from "vitest";
import {
	appendGrammarToolInputJsonDelta,
	closeGrammarToolInputJson,
	createGrammarToolInputProperties,
	getGrammarToolInput,
	getJsonSchemaToolParameters,
	makeStrictJsonSchema,
	resolveGrammarConstrainedSampling,
	resolveJsonSchemaStrictSampling,
} from "../src/api/constrained-sampling.ts";
import { isStrictToolLimitErrorMessage } from "../src/api/strict-tool-limits.ts";
import { convertResponsesTools } from "../src/api/openai-responses-shared.ts";
import type { Tool } from "../src/types.ts";

const tool: Tool = {
	name: "source",
	description: "Read source text",
	parameters: { type: "object", properties: { source: { type: "string" } }, required: ["source"] },
};

test("strict schema conversion rejects unsupported compositions and malformed schema boundaries", () => {
	for (const keyword of [
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
	])
		expect(() => makeStrictJsonSchema({ type: "object", [keyword]: {} })).toThrow(/unsupported/);
	for (const schema of [
		true,
		null,
		[],
		{ type: "array" },
		{ type: "object", properties: [] },
		{ type: "object", required: [1] },
		{ type: "object", required: "source" },
		{ type: "object", required: ["missing"], properties: {} },
		{ type: "object", additionalProperties: true },
		{ type: "object", properties: { x: { anyOf: [] } } },
		{ type: "object", properties: { x: { anyOf: {} } } },
		{ type: "object", properties: { x: { anyOf: [{ type: "object" }, { type: "null" }] } } },
		{ type: "object", properties: { x: { anyOf: [{ type: ["array", "null"] }] } } },
		{ type: "object", properties: { x: { type: "array", items: [{ type: "string" }] } } },
		{ type: "object", properties: { x: { type: "string", properties: {} } } },
		{ type: "object", properties: { x: true } },
	])
		expect(() => Reflect.apply(makeStrictJsonSchema, undefined, [schema])).toThrow();
});

test("strict conversion preserves existing nullable declarations and normalizes nested optional object fields", () => {
	const properties = {
		union: { type: ["string", "null"] },
		constant: { type: "null", const: null },
		enumeration: { enum: ["yes", null] },
		explicit: { anyOf: [{ type: "string" }, { type: "null" }] },
		recursive: { anyOf: [{ anyOf: [{ enum: [null, "value"] }] }, { type: "string" }] },
		items: { type: "array", items: { type: "object", properties: { label: { type: "string" } } } },
	};
	const before = structuredClone(properties);
	const strict = makeStrictJsonSchema({ type: "object", properties });
	expect(strict).toMatchObject({
		additionalProperties: false,
		required: Object.keys(properties),
		properties: {
			union: properties.union,
			constant: properties.constant,
			enumeration: properties.enumeration,
			explicit: properties.explicit,
			recursive: properties.recursive,
			items: {
				anyOf: [
					{
						type: "array",
						items: {
							type: "object",
							required: ["label"],
							additionalProperties: false,
							properties: { label: { anyOf: [{ type: "string" }, { type: "null" }] } },
						},
					},
					{ type: "null" },
				],
			},
		},
	});
	expect(properties).toEqual(before);
	expect(makeStrictJsonSchema({ type: "object" })).toEqual({
		type: "object",
		required: [],
		additionalProperties: false,
	});
});

test("required and preferred constraints select strict encoding or a declared fallback", () => {
	const invalid: Tool = { ...tool, parameters: { type: "object", additionalProperties: true } };
	for (const supports of [false, true]) {
		expect(
			resolveJsonSchemaStrictSampling(
				{ ...invalid, constrainedSampling: { type: "json_schema", strict: "prefer" } },
				supports,
			),
		).toBeUndefined();
		expect(() =>
			resolveJsonSchemaStrictSampling(
				{ ...invalid, constrainedSampling: { type: "json_schema", strict: "require" } },
				supports,
			),
		).toThrow(/requires JSON-schema/);
	}
	const constrained: Tool = { ...tool, constrainedSampling: { type: "json_schema", strict: "require" } };
	expect(resolveJsonSchemaStrictSampling(constrained, true)).toBe(true);
	expect(() => resolveJsonSchemaStrictSampling(constrained, true, (key) => key === "type")).toThrow(/unsupported/);
	const failure = new Error("Provider keyword validation failed");
	expect(() =>
		resolveJsonSchemaStrictSampling(constrained, true, () => {
			throw failure;
		}),
	).toThrow(failure);
	expect(getJsonSchemaToolParameters(tool, undefined)).toBe(tool.parameters);
	expect(getJsonSchemaToolParameters(tool, false)).toBe(tool.parameters);
	expect(getJsonSchemaToolParameters(tool, true)).not.toBe(tool.parameters);
	expect(convertResponsesTools([constrained])).toMatchObject([
		{ type: "function", name: "source", strict: true, parameters: { additionalProperties: false } },
	]);
});

test.each([
	{
		label: "unconstrained array members",
		parameters: { type: "object", properties: { arguments: { type: "array", items: {} } } },
	},
	{
		label: "untyped annotated values",
		parameters: { type: "object", properties: { metadata: { description: "Any JSON payload" } } },
	},
	{
		label: "const-only properties",
		parameters: { type: "object", properties: { mode: { const: "basic" } }, required: ["mode"] },
	},
])("strict preferences fall back for $label and requirements reject before sending", ({ parameters }) => {
	const before = structuredClone(parameters);
	const preferred: Tool = {
		...tool,
		parameters,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
	};
	expect(resolveJsonSchemaStrictSampling(preferred, true)).toBeUndefined();
	expect(convertResponsesTools([preferred], { supportsStrictMode: true })).toMatchObject([
		{ strict: false, parameters },
	]);
	const required: Tool = { ...preferred, constrainedSampling: { type: "json_schema", strict: "require" } };
	expect(() => convertResponsesTools([required], { supportsStrictMode: true })).toThrow(/without a type/);
	expect(parameters).toEqual(before);
});

test("an enum without a type retains strict encoding for both preferences and requirements", () => {
	for (const strict of ["prefer", "require"] as const) {
		const constrained: Tool = {
			...tool,
			parameters: { type: "object", properties: { level: { enum: ["low", "high"] } }, required: ["level"] },
			constrainedSampling: { type: "json_schema", strict },
		};
		expect(convertResponsesTools([constrained], { supportsStrictMode: true })).toMatchObject([
			{ strict: true, parameters: { properties: { level: { enum: ["low", "high"] } } } },
		]);
	}
});

test("grammar variants prefer a nonempty Lark definition and validate their single string input", () => {
	const constrained: Tool = {
		...tool,
		constrainedSampling: { type: "grammar", variants: { openai_lark: 'start: "text"', openai_regex: "text" } },
	};
	expect(resolveGrammarConstrainedSampling(constrained, true)).toEqual({
		format: "lark",
		definition: 'start: "text"',
		inputProperty: "source",
	});
	expect(
		resolveGrammarConstrainedSampling(
			{
				...constrained,
				constrainedSampling: { type: "grammar", variants: { openai_lark: "  ", openai_regex: "text" } },
			},
			true,
		),
	).toMatchObject({ format: "regex", definition: "text" });
	expect(resolveGrammarConstrainedSampling(constrained, false)).toBeUndefined();
	expect(createGrammarToolInputProperties([tool, constrained], true)).toEqual(new Map([["source", "source"]]));
	expect(createGrammarToolInputProperties(undefined, true).size).toBe(0);
	for (const parameters of [
		{ type: "string" },
		{ type: "object" },
		{ type: "object", required: [] },
		{ type: "object", required: ["a", "b"] },
		{ type: "object", required: ["source"] },
		{ type: "object", required: ["source"], properties: { source: { type: "number" } } },
	])
		expect(() => resolveGrammarConstrainedSampling({ ...constrained, parameters }, true)).toThrow(/cannot use grammar/);
	expect(() =>
		resolveGrammarConstrainedSampling({ ...constrained, constrainedSampling: { type: "grammar", variants: {} } }, true),
	).toThrow(/no supported grammar variant/);
	expect(getGrammarToolInput("source", { source: "text" }, "source")).toBe("text");
	for (const value of [undefined, null, 1, {}, []])
		expect(() => getGrammarToolInput("source", { source: value }, "source")).toThrow(/string/);
});

test("grammar streaming produces valid JSON at every chunking and never permits edits after completion", () => {
	for (const source of ["", 'quoted " and \\', "first\nsecond\t\u0000", "界🙂e\u0301", "unpaired \ud800 end"])
		for (const size of [1, 2, 3, 7]) {
			const buffer = { input: "", started: false, closed: false };
			const parts: string[] = [];
			expect(appendGrammarToolInputJsonDelta(buffer, "source", "")).toBeUndefined();
			for (let offset = 0; offset < source.length; offset += size) {
				const delta = appendGrammarToolInputJsonDelta(buffer, "source", source.slice(offset, offset + size));
				if (delta !== undefined) parts.push(delta);
			}
			parts.push(closeGrammarToolInputJson(buffer, "source", undefined) ?? "");
			expect(JSON.parse(parts.join(""))).toEqual({ source });
			expect(closeGrammarToolInputJson(buffer, "source", undefined)).toBeUndefined();
			expect(closeGrammarToolInputJson(buffer, "source", source)).toBeUndefined();
			expect(() => appendGrammarToolInputJsonDelta(buffer, "source", "changed")).toThrow(/after it was closed/);
			expect(() => closeGrammarToolInputJson(buffer, "source", source + "changed")).toThrow(/after it was closed/);
		}
	const partial = { input: "before", started: true, closed: false };
	expect(() => closeGrammarToolInputJson(partial, "source", "different")).toThrow(/non-monotonically/);
});

test("strict tool-limit errors are recognized without classifying unrelated provider failures", () => {
	for (const message of [
		"The compiled grammar is too large",
		"Too many strict tools (128)",
		"Schemas contains too many parameters with union types (42)",
	])
		expect(isStrictToolLimitErrorMessage(message)).toBe(true);
	for (const message of ["", "rate limit", "invalid token", "unknown tool"])
		expect(isStrictToolLimitErrorMessage(message)).toBe(false);
});
