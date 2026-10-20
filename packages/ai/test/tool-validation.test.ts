import { expect, test } from "vitest";
import { validateToolArguments, validateToolCall } from "../src/utils/validation.ts";
import type { Tool, ToolCall } from "../src/types.ts";

const tool: Tool = {
	name: "configure",
	description: "Apply settings",
	parameters: {
		type: "object",
		required: ["count", "enabled", "values", "nested", "choice"],
		properties: {
			count: { type: "integer" },
			enabled: { type: "boolean" },
			values: { type: "array", items: { type: "number" } },
			nested: {
				type: "object",
				required: ["label"],
				properties: { label: { type: "string" }, optional: { type: "string" } },
			},
			choice: { anyOf: [{ type: "number" }, { type: "boolean" }] },
			optional: { type: "string" },
		},
		additionalProperties: { type: "integer" },
	},
};
test("tool validation coerces nested JSON schemas, omits optional nulls and leaves caller arguments intact", () => {
	const call: ToolCall = {
		type: "toolCall",
		id: "call-1",
		name: "configure",
		arguments: {
			count: "3",
			enabled: "true",
			values: ["1", false, null],
			nested: { label: 4, optional: null },
			choice: "7",
			optional: null,
			extra: "9",
		},
	};
	expect(validateToolCall([tool], call)).toEqual({
		count: 3,
		enabled: true,
		values: [1, 0, 0],
		nested: { label: "4" },
		choice: 7,
		extra: 9,
	});
	expect(call.arguments).toEqual({
		count: "3",
		enabled: "true",
		values: ["1", false, null],
		nested: { label: 4, optional: null },
		choice: "7",
		optional: null,
		extra: "9",
	});
});
test("tool validation distinguishes unknown tools, broken JSON and schema failures", () => {
	const call: ToolCall = { type: "toolCall", id: "call-2", name: "configure", arguments: { count: "bad" } };
	expect(() => validateToolCall([], call)).toThrow('Tool "configure" not found');
	expect(() => validateToolArguments(tool, { ...call, argumentsError: "Unclosed JSON object" })).toThrow(
		'Invalid arguments for tool "configure": Unclosed JSON object',
	);
	expect(() => validateToolArguments(tool, call)).toThrow(/Validation failed for tool "configure"/);
	expect(() => validateToolArguments(tool, call)).toThrow(/count/);
});
