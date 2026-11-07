import { expect, expectTypeOf, test } from "vitest";
import { type Static, Type } from "typebox";
import { StringEnum } from "@axi/ai/utils/string-enum";
import { validateToolArguments, validateToolCall } from "../src/utils/validation.ts";
import type { Tool, ToolCall } from "../src/types.ts";

test("the string enum entry point supplies a typed provider-compatible tool schema", () => {
	const direction = StringEnum(["up", "down"] as const, { description: "Direction", default: "up" });
	expectTypeOf<Static<typeof direction>>().toEqualTypeOf<"up" | "down">();
	expect(JSON.parse(JSON.stringify(direction))).toEqual({
		type: "string",
		enum: ["up", "down"],
		description: "Direction",
		default: "up",
	});
	const move: Tool = { name: "move", description: "Move", parameters: Type.Object({ direction }) };
	const call: ToolCall = { type: "toolCall", id: "move-1", name: "move", arguments: { direction: "down" } };
	expect(validateToolArguments(move, call)).toEqual({ direction: "down" });
	expect(() => validateToolArguments(move, { ...call, arguments: { direction: "left" } })).toThrow("Validation failed");
});

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

test("serialized tool schemas retain required-value conversions and caller ownership", () => {
	const parameters = Type.Object({
		label: Type.String(),
		enabled: Type.Boolean(),
		disabled: Type.Boolean(),
		count: Type.Integer(),
		amounts: Type.Array(Type.Number()),
		absent: Type.Null(),
	});
	for (const schema of [parameters, JSON.parse(JSON.stringify(parameters))]) {
		const convert: Tool = { name: "convert", description: "Convert fields", parameters: schema };
		const call: ToolCall = {
			type: "toolCall",
			id: "convert-1",
			name: "convert",
			arguments: { label: null, enabled: "1", disabled: "FaLsE", count: " -9.3 ", amounts: "2.75", absent: "null" },
		};
		const original = structuredClone(call.arguments);
		expect(validateToolArguments(convert, call)).toEqual({
			label: "null",
			enabled: true,
			disabled: false,
			count: -9,
			amounts: [2.75],
			absent: null,
		});
		expect(call.arguments).toEqual(original);
	}
});

test("tool conversion follows local references through nested values", () => {
	const convert: Tool = {
		name: "convert",
		description: "Convert referenced fields",
		parameters: {
			type: "object",
			$defs: {
				"whole/count": { type: "integer" },
				entry: { type: "object", required: ["label"], properties: { label: { type: "string" } } },
			},
			required: ["count", "entries", "summary"],
			properties: {
				count: { $ref: "#/$defs/whole~1count" },
				entries: { type: "array", items: { $ref: "#/$defs/entry" } },
				summary: {
					anyOf: [
						{ type: "object", properties: { total: { $ref: "#/$defs/whole~1count" } }, required: ["total"] },
						{ type: "null" },
					],
				},
			},
		},
	};
	const call: ToolCall = {
		type: "toolCall",
		id: "convert-2",
		name: "convert",
		arguments: { count: "-9.3", entries: [{ label: null }], summary: { total: "4.75" } },
	};
	expect(validateToolArguments(convert, call)).toEqual({
		count: -9,
		entries: [{ label: "null" }],
		summary: { total: 4 },
	});
	expect(call.arguments).toEqual({ count: "-9.3", entries: [{ label: null }], summary: { total: "4.75" } });
	expect(() => validateToolArguments(convert, { ...call, arguments: { count: "not a number", entries: [] } })).toThrow(
		"Validation failed",
	);
});

test("multiple declared JSON types preserve matches and use their declared conversion order", () => {
	const convert: Tool = {
		name: "convert",
		description: "Convert a union",
		parameters: {
			type: "object",
			required: ["value"],
			properties: { value: { type: ["boolean", "number"] } },
		},
	};
	const call: ToolCall = { type: "toolCall", id: "convert-3", name: "convert", arguments: { value: "1" } };
	expect(validateToolArguments(convert, call)).toEqual({ value: 1 });
	expect(validateToolArguments(convert, { ...call, arguments: { value: false } })).toEqual({ value: false });
	expect(validateToolArguments(convert, { ...call, arguments: { value: null } })).toEqual({ value: false });
	expect(() => validateToolArguments(convert, { ...call, arguments: { value: "TRUE" } })).toThrow("Validation failed");
});

test("recursive local references convert each nested object", () => {
	const convert: Tool = {
		name: "convert",
		description: "Convert a recursive record",
		parameters: {
			type: "object",
			properties: { count: { type: "integer" }, next: { $ref: "#" } },
			required: ["count"],
		},
	};
	const call: ToolCall = {
		type: "toolCall",
		id: "convert-4",
		name: "convert",
		arguments: { count: "5.8", next: { count: "-1.8" } },
	};
	expect(validateToolArguments(convert, call)).toEqual({ count: 5, next: { count: -1 } });
	expect(call.arguments).toEqual({ count: "5.8", next: { count: "-1.8" } });
});

test("an explicitly undefined optional argument remains absent after argument repair", () => {
	const convert: Tool = {
		name: "convert",
		description: "Validate repaired arguments",
		parameters: Type.Object({ label: Type.Optional(Type.String()) }),
	};
	const call: ToolCall = { type: "toolCall", id: "convert-5", name: "convert", arguments: {} };
	Reflect.set(call.arguments, "label", undefined);
	expect(validateToolArguments(convert, call)).toEqual({ label: undefined });
	expect(Object.hasOwn(call.arguments, "label")).toBe(true);
});
