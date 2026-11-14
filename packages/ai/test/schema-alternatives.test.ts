import { expect, test } from "vitest";
import type { Tool, ToolCall } from "../src/types.ts";
import { validateToolArguments } from "../src/utils/validation.ts";

function call(value: ToolCall["arguments"][string]): ToolCall {
	return { type: "toolCall", id: "schema-input", name: "read", arguments: { value } };
}
function tool(property: Tool["parameters"], definitions: Record<string, unknown> = {}): Tool {
	return {
		name: "read",
		description: "Read a schema value",
		parameters: {
			type: "object",
			required: ["value"],
			properties: { value: property },
			$defs: definitions,
		},
	};
}

test.each([
	{ type: "number", value: 1.25 },
	{ type: "integer", value: 8 },
	{ type: "boolean", value: false },
	{ type: "string", value: "seven" },
	{ type: "null", value: null },
	{ type: "array", value: [1, 2] },
	{ type: "object", value: { label: "nested" } },
])("a matching $type alternative preserves its type and caller ownership", ({ type, value }) => {
	const input = call(value),
		original = structuredClone(input);
	const validated = validateToolArguments(tool({ type: [type, type === "null" ? "string" : "null"] }), input);
	expect(validated).toEqual({ value });
	expect(input).toEqual(original);
	if (value !== null && typeof value === "object") expect(validated.value).not.toBe(value);
});

test.each([true, false])("local references retain boolean schema semantics (%s)", (allowed) => {
	const read = tool({ $ref: "#/$defs/choice" }, { choice: allowed });
	for (const value of [null, false, 0, "text", [], { nested: true }]) {
		if (allowed) expect(validateToolArguments(read, call(value))).toEqual({ value });
		else expect(() => validateToolArguments(read, call(value))).toThrow("no value is allowed here");
	}
});

test("oneOf distinguishes an ambiguous valid value from a value matching no alternative", () => {
	const read = tool({ oneOf: [{ type: "number" }, { type: "integer" }] });
	expect(validateToolArguments(read, call(1.5))).toEqual({ value: 1.5 });
	expect(() => validateToolArguments(read, call(3))).toThrow("matches more than one alternative");
	expect(() => validateToolArguments(read, call({ nested: true }))).toThrow("expected number, got object");
});

test.each([
	{ value: 2, schema: { const: { count: 2 } } },
	{ value: { count: 3 }, schema: { const: { count: 2 } } },
	{ value: "other", schema: { enum: [null, true, { count: 2 }] } },
])("failed literal conversion leaves transcript arguments intact: $value", ({ value, schema }) => {
	const input = call(value),
		original = structuredClone(input);
	expect(() => validateToolArguments(tool(schema), input)).toThrow("Validation failed");
	expect(input).toEqual(original);
});

test("tuple errors name a rejected additional position and preserve existing array entries", () => {
	const read = tool({ type: "array", prefixItems: [{ type: "string" }], items: false });
	const input = call(["first", "extra"]);
	expect(() => validateToolArguments(read, input)).toThrow("value.1");
	expect(input.arguments).toEqual({ value: ["first", "extra"] });
});

test("a failing pattern-property reference reports its escaped input field", () => {
	const read = tool(
		{ type: "object", patternProperties: { "^a/": { $ref: "#/$defs/count" } } },
		{
			count: { type: "integer", minimum: 2 },
		},
	);
	expect(() => validateToolArguments(read, call({ "a/~count": 1 }))).toThrow("value.a/~count: expected >= 2");
	expect(validateToolArguments(read, call({ "a/~count": "3" }))).toEqual({ value: { "a/~count": 3 } });
});
