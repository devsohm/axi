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

test("invalid tool arguments report their received type and each missing field", () => {
	const inspect: Tool = {
		name: "inspect", description: "Inspect coordinates",
		parameters: Type.Object({ x: Type.Number(), y: Type.Number() }),
	};
	const call: ToolCall = { type: "toolCall", id: "inspect-1", name: "inspect", arguments: { x: "bad", y: 1 } };
	expect(() => validateToolArguments(inspect, call)).toThrow(
		'Validation failed for tool "inspect":\n  - x: expected number, got string\n\nReceived arguments:\n{\n  "x": "bad",\n  "y": 1\n}',
	);
	expect(() => validateToolArguments(inspect, { ...call, arguments: {} })).toThrow(
		'Validation failed for tool "inspect":\n  - x: missing\n  - y: missing\n\nReceived arguments:\n{}',
	);
	const escaped: Tool = { ...inspect, parameters: Type.Object({ "x/~": Type.Number() }) };
	expect(() => validateToolArguments(escaped, { ...call, arguments: { "x/~": "bad" } })).toThrow(
		"  - x/~: expected number, got string",
	);
});

test("tool constraint diagnostics explain the limit and allowed values", () => {
	for (const [schema, value, expected] of [
		[Type.String({ minLength: 4 }), "short".slice(0, 2), "expected at least 4 characters"],
		[Type.Number({ maximum: 2 }), 3, "expected <= 2"],
		[Type.Array(Type.Number(), { minItems: 2 }), [1], "expected at least 2 items"],
		[{ enum: ["up", "down"] }, "sideways", 'expected one of ["up","down"]'],
	] as const) {
		const inspect: Tool = { name: "inspect", description: "Inspect an input", parameters: Type.Object({ value: schema }) };
		const call: ToolCall = { type: "toolCall", id: "inspect-2", name: "inspect", arguments: { value } };
		expect(() => validateToolArguments(inspect, call)).toThrow(`  - value: ${expected}`);
	}
});

test("tool diagnostics select the intended union member and report invalid fields before extras", () => {
	const point = Type.Object({ x: Type.Number() }, { additionalProperties: false });
	const named = Type.Object({ name: Type.String() }, { additionalProperties: false });
	const inspect: Tool = { name: "inspect", description: "Inspect a location", parameters: Type.Object({ value: Type.Union([named, point]) }) };
	const call: ToolCall = { type: "toolCall", id: "inspect-3", name: "inspect", arguments: { value: { x: "bad" } } };
	expect(() => validateToolArguments(inspect, call)).toThrow(
		'Validation failed for tool "inspect":\n  - value.x: expected number, got string\n\nReceived arguments:\n{\n  "value": {\n    "x": "bad"\n  }\n}',
	);
	const direct = { ...inspect, parameters: Type.Object({ value: point }) };
	expect(() => validateToolArguments(direct, { ...call, arguments: { value: { x: "bad", z: 2 } } })).toThrow(
		"  - value.x: expected number, got string\n  - value.z: unknown field",
	);
	const tagged: Tool = { ...inspect, parameters: Type.Object({ value: Type.Union([
		Type.Object({ kind: Type.Literal("a"), title: Type.String() }, { additionalProperties: false }),
		Type.Object({ kind: Type.Literal("b"), count: Type.Number() }, { additionalProperties: false }),
	]) }) };
	expect(() => validateToolArguments(tagged, { ...call, arguments: { value: { kind: "other", count: 1 } } }))
		.toThrow('  - value.kind: expected one of ["a","b"]');
	expect(() => validateToolArguments(tagged, { ...call, arguments: { value: { kind: "a", count: 1 } } }))
		.toThrow("  - value.title: missing\n  - value.count: unknown field");
	const tied: Tool = { ...inspect, parameters: Type.Object({ value: Type.Union([
		Type.Object({ field: Type.Number(), veryLongMissingField: Type.String() }, { additionalProperties: false }),
		Type.Object({ field: Type.Integer() }, { additionalProperties: false }),
	]) }) };
	expect(() => validateToolArguments(tied, { ...call, arguments: { value: { field: [] } } }))
		.toThrow("  - value.veryLongMissingField: missing\n  - value.field: expected number, got array");
});

test("invalid values in referenced unions retain validation diagnostics", () => {
	const inspect: Tool = { name: "inspect", description: "Inspect a referenced value", parameters: {
		type: "object", $defs: { choice: { anyOf: [{ type: "number" }, { type: "boolean" }] },
			container: { type: "object", properties: { nested: { $ref: "#/$defs/choice" } }, required: ["nested"] } },
		properties: { value: { $ref: "#/$defs/container" } }, required: ["value"],
	} };
	const call: ToolCall = { type: "toolCall", id: "inspect-4", name: "inspect", arguments: { value: { nested: {} } } };
	expect(() => validateToolArguments(inspect, call)).toThrow("  - value.nested: expected number, got object");
	expect(validateToolArguments(inspect, { ...call, arguments: { value: { nested: 2 } } })).toEqual({ value: { nested: 2 } });
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

test("JSON tuples convert prefix items and enforce their remaining-item schema", () => {
	const tuple = { type: "array", prefixItems: [{ type: "integer" }, { type: "boolean" }], items: false };
	const convert: Tool = {
		name: "convert",
		description: "Convert a tuple",
		parameters: {
			type: "object",
			properties: { values: tuple },
			required: ["values"],
		},
	};
	const call: ToolCall = { type: "toolCall", id: "convert-6", name: "convert", arguments: { values: ["5.8", "TRUE"] } };
	expect(validateToolArguments(convert, call)).toEqual({ values: [5, true] });
	expect(call.arguments).toEqual({ values: ["5.8", "TRUE"] });
	expect(() => validateToolArguments(convert, { ...call, arguments: { values: ["5.8", "TRUE", 1] } })).toThrow(
		"Validation failed",
	);
	const tailed = {
		...convert,
		parameters: { ...convert.parameters, properties: { values: { ...tuple, items: { type: "number" } } } },
	};
	expect(validateToolArguments(tailed, { ...call, arguments: { values: ["5.8", "TRUE", "9.5"] } })).toEqual({
		values: [5, true, 9.5],
	});
});

test("pattern properties convert matching keys before additional-property rules", () => {
	const convert: Tool = {
		name: "convert",
		description: "Convert a patterned record",
		parameters: {
			type: "object",
			properties: { title: { type: "string" } },
			patternProperties: { "^count/": { type: "integer" }, "^active/": { type: "boolean" } },
			additionalProperties: { type: "number" },
		},
	};
	const args = { title: 12, "count/one": "-5.8", "active/one": "TRUE", extra: "9.5" };
	const original = structuredClone(args);
	const call: ToolCall = { type: "toolCall", id: "convert-7", name: "convert", arguments: args };
	expect(validateToolArguments(convert, call)).toEqual({
		title: "12",
		"count/one": -5,
		"active/one": true,
		extra: 9.5,
	});
	expect(call.arguments).toEqual(original);
	expect(() => validateToolArguments(convert, { ...call, arguments: { "count/one": "invalid" } })).toThrow(
		"Validation failed",
	);
	const closed = { ...convert, parameters: { ...convert.parameters, additionalProperties: false } };
	expect(validateToolArguments(closed, { ...call, arguments: { "count/one": "5.8" } })).toEqual({ "count/one": 5 });
	expect(() => validateToolArguments(closed, { ...call, arguments: { extra: 1 } })).toThrow("Validation failed");
});

test("optional null cleanup reaches tuple, pattern and additional values before conversion", () => {
	const entry = { type: "object", properties: { label: { type: "string" } } };
	const convert: Tool = {
		name: "convert",
		description: "Prepare containers",
		parameters: {
			type: "object",
			$defs: { entry },
			properties: {
				tuple: { type: "array", prefixItems: [entry], items: false },
				pattern: { type: "object", patternProperties: { "^item$": entry } },
				extra: { type: "object", additionalProperties: entry },
				choice: { anyOf: [entry, { type: "null" }] },
				reference: { $ref: "#/$defs/entry" },
			},
		},
	};
	const arguments_ = {
		tuple: [{ label: null }],
		pattern: { item: { label: null } },
		extra: { item: { label: null } },
		choice: { label: null },
		reference: { label: null },
	};
	const before = structuredClone(arguments_);
	expect(
		validateToolArguments(convert, { type: "toolCall", id: "containers", name: "convert", arguments: arguments_ }),
	).toEqual({
		tuple: [{}],
		pattern: { item: {} },
		extra: { item: {} },
		choice: { label: "null" },
		reference: { label: "null" },
	});
	expect(arguments_).toEqual(before);
});

test("literal and enum conversions preserve matching values and select the first accepted literal", () => {
	const convert: Tool = {
		name: "convert",
		description: "Read choices",
		parameters: {
			type: "object",
			properties: { literal: { const: true }, choice: { enum: [0, false, "true", null] } },
			required: ["literal", "choice"],
		},
	};
	const call: ToolCall = {
		type: "toolCall",
		id: "choices",
		name: "convert",
		arguments: { literal: "TRUE", choice: "false" },
	};
	expect(validateToolArguments(convert, call)).toEqual({ literal: true, choice: 0 });
	expect(validateToolArguments(convert, { ...call, arguments: { literal: 1, choice: false } })).toEqual({
		literal: true,
		choice: false,
	});
	expect(() => validateToolArguments(convert, { ...call, arguments: { literal: "wrong", choice: 1 } })).toThrow(
		"Validation failed",
	);
});

test("tuples require arrays while schemas declaring only members still convert their values", () => {
	const parameters = {
		type: "object",
		properties: {
			tuple: { type: "array", prefixItems: [{ type: "integer" }], items: false },
			array: { items: { type: "integer" } },
			record: { properties: { count: { type: "integer" } } },
			choice: { anyOf: [{ type: "object" }, { type: "null" }], properties: { enabled: { type: "boolean" } } },
		},
		required: ["tuple", "array", "record", "choice"],
	};
	const convert: Tool = { name: "convert", description: "Read containers", parameters };
	const call: ToolCall = {
		type: "toolCall",
		id: "members",
		name: "convert",
		arguments: { tuple: ["3.8"], array: "3.8", record: { count: "3.8" }, choice: { enabled: "TRUE" } },
	};
	expect(validateToolArguments(convert, call)).toEqual({
		tuple: [3],
		array: [3],
		record: { count: 3 },
		choice: { enabled: true },
	});
	expect(() => validateToolArguments(convert, { ...call, arguments: { ...call.arguments, tuple: "3.8" } })).toThrow(
		"Validation failed",
	);
});

test("declared type arrays use primitive coercion after structural conversions", () => {
	const convert: Tool = {
		name: "convert",
		description: "Read nullable containers",
		parameters: {
			type: "object",
			properties: {
				record: { type: ["object", "null"], properties: { enabled: { type: "boolean" } } },
				array: { type: ["array", "null"], items: { type: "integer" } },
			},
			required: ["record", "array"],
		},
	};
	const call: ToolCall = {
		type: "toolCall",
		id: "nullable",
		name: "convert",
		arguments: { record: { enabled: "true" }, array: ["3"] },
	};
	expect(validateToolArguments(convert, call)).toEqual({ record: { enabled: true }, array: [3] });
	expect(validateToolArguments(convert, { ...call, arguments: { record: null, array: null } })).toEqual({
		record: null,
		array: null,
	});
	expect(() =>
		validateToolArguments(convert, { ...call, arguments: { ...call.arguments, record: { enabled: "TRUE" } } }),
	).toThrow("Validation failed");
	expect(() => validateToolArguments(convert, { ...call, arguments: { ...call.arguments, array: ["3.8"] } })).toThrow(
		"Validation failed",
	);
});

test("an unrestricted union branch keeps values unchanged", () => {
	const convert: Tool = {
		name: "convert",
		description: "Read an unrestricted choice",
		parameters: { type: "object", properties: { value: { anyOf: [true, { type: "boolean" }] } } },
	};
	for (const value of ["true", "FALSE", null, { enabled: "true" }]) {
		const args = { value };
		expect(
			validateToolArguments(convert, { type: "toolCall", id: "choice", name: "convert", arguments: args }),
		).toEqual(args);
	}
});

test("local references belong to their enclosing schema resource", () => {
	const resource = {
		$id: "urn:tool:amount",
		$defs: { amount: { type: "number" } },
		$ref: "#/$defs/amount",
	};
	const convert: Tool = {
		name: "convert",
		description: "Read scoped references",
		parameters: {
			type: "object",
			$defs: { amount: { type: "string" } },
			properties: { scoped: resource, outer: { $ref: "#/$defs/amount" } },
		},
	};
	const call: ToolCall = {
		type: "toolCall",
		id: "references",
		name: "convert",
		arguments: { scoped: "3.8", outer: 42 },
	};
	expect(validateToolArguments(convert, call)).toEqual({ scoped: 3.8, outer: "42" });
	expect(call.arguments).toEqual({ scoped: "3.8", outer: 42 });
	const missing = {
		...convert,
		parameters: {
			type: "object",
			properties: { value: { $defs: { amount: { type: "number" } }, $ref: "#/$defs/amount" } },
		},
	};
	expect(validateToolArguments(missing, { ...call, arguments: {} })).toEqual({});
	expect(() => validateToolArguments(missing, { ...call, arguments: { value: 3.8 } })).toThrow("Validation failed");
});

test("local reference fragments decode URI escapes before JSON Pointer escapes", () => {
	for (const [key, ref] of [["a b", "a%20b"], ["α", "%CE%B1"], ["a/b", "a~1b"], ["a~b", "a~0b"], ["%20", "%2520"]]) {
		const inspect: Tool = {
			name: "inspect", description: "Read a referenced number",
			parameters: { type: "object", $defs: { [key]: { type: "number" } }, properties: { value: { $ref: `#/$defs/${ref}` } } },
		};
		const call: ToolCall = { type: "toolCall", id: "fragment", name: "inspect", arguments: { value: "4.5" } };
		expect(validateToolArguments(inspect, call)).toEqual({ value: 4.5 });
		expect(call.arguments).toEqual({ value: "4.5" });
		expect(() => validateToolArguments(inspect, { ...call, arguments: { value: [] } })).toThrow("value: expected number, got array");
	}
});

test("unresolved or malformed reference fragments fail only when their field is present", () => {
	for (const ref of ["#/$defs/missing", "#/$defs/%", "#/$defs/%CE"]) {
		const inspect: Tool = {
			name: "inspect", description: "Read an optional reference",
			parameters: { type: "object", properties: { value: { $ref: ref } } },
		};
		const call: ToolCall = { type: "toolCall", id: "missing-fragment", name: "inspect", arguments: {} };
		expect(validateToolArguments(inspect, call)).toEqual({});
		expect(() => validateToolArguments(inspect, { ...call, arguments: { value: 4 } })).toThrow(`value: unresolved reference ${ref}`);
	}
});
