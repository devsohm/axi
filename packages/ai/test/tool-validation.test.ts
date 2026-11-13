import { spawnSync } from "node:child_process";
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
test("JSON arguments convert to bigint and undefined without changing their transcript values", () => {
	const parameters = Type.Object({ value: Type.BigInt(), empty: Type.Undefined() });
	for (const schema of [parameters, JSON.parse(JSON.stringify(parameters))]) {
		const convert: Tool = { name: "convert", description: "Convert extended values", parameters: schema };
		for (const [value, expected] of [
			["9007199254740993", 9007199254740993n],
			[42.9, 42n],
			[-3.5, -3n],
			[true, 1n],
			[null, 0n],
		] as const) {
			const call: ToolCall = { type: "toolCall", id: "extended", name: "convert", arguments: { value, empty: null } };
			expect(validateToolArguments(convert, call)).toEqual({ value: expected, empty: undefined });
			expect(call.arguments).toEqual({ value, empty: null });
		}
		const call: ToolCall = {
			type: "toolCall",
			id: "invalid-extended",
			name: "convert",
			arguments: { value: "invalid", empty: null },
		};
		expect(() => validateToolArguments(convert, call)).toThrow("expected bigint, got string");
	}
	const acceptsString: Tool = {
		name: "choice",
		description: "Read a value",
		parameters: Type.Object({ value: Type.Union([Type.BigInt(), Type.String()]) }),
	};
	expect(
		validateToolArguments(acceptsString, {
			type: "toolCall",
			id: "choice",
			name: "choice",
			arguments: { value: "42" },
		}),
	).toEqual({ value: "42" });
	const voidTool: Tool = { name: "void", description: "Reject JSON", parameters: Type.Object({ value: Type.Void() }) };
	expect(() =>
		validateToolArguments(voidTool, { type: "toolCall", id: "void", name: "void", arguments: { value: null } }),
	).toThrow("Validation failed");
});
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

test("named schema resources convert nested values and reject absent resource names", () => {
	const parameters = Type.Object({
		branch: Type.Cyclic(
			{ Branch: Type.Object({ label: Type.String(), children: Type.Array(Type.Ref("Branch")) }) },
			"Branch",
		),
	});
	const tree: Tool = { name: "tree", description: "Read a tree", parameters };
	const call: ToolCall = {
		type: "toolCall",
		id: "tree",
		name: "tree",
		arguments: { branch: { label: 9, children: [] } },
	};
	expect(validateToolArguments(tree, call)).toEqual({ branch: { label: "9", children: [] } });
	expect(call.arguments).toEqual({ branch: { label: 9, children: [] } });
	const unresolved: Tool = { ...tree, parameters: Type.Object({ branch: Type.Ref("Absent") }) };
	expect(() => validateToolArguments(unresolved, call)).toThrow("branch: unresolved reference Absent");
});

test("recursive alternatives finish without repeated exponential conversion or transcript mutation", () => {
	const module = new URL("../src/utils/validation.ts", import.meta.url).href;
	const result = spawnSync(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`
		import { validateToolArguments } from ${JSON.stringify(module)};
		const branch = { anyOf: [
			{ type: "object", required: ["left"], additionalProperties: { $ref: "#/$defs/Branch" } },
			{ type: "object", required: ["right"], additionalProperties: { $ref: "#/$defs/Branch" } }
		] };
		let tree = { leaf: false };
		for (let depth = 0; depth < 45; depth++) tree = { child: tree };
		const parameters = { type: "object", properties: { tree: { $ref: "#/$defs/Branch" } }, $defs: { Branch: branch } };
		try {
			validateToolArguments({ name: "read", description: "", parameters }, { type: "toolCall", id: "recursive", name: "read", arguments: { tree } });
			process.exitCode = 1;
		} catch (error) {
			if (!/tree\\.(left|right): missing/.test(error.message)) throw error;
		}
	`,
		],
		{ encoding: "utf8", timeout: 4000 },
	);
	expect(result.error).toBeUndefined();
	expect(result.stderr).toBe("");
	expect(result.status).toBe(0);

	const recursive: Tool = {
		name: "read",
		description: "Read text or nested text lists",
		parameters: {
			type: "object",
			properties: { value: { $ref: "#/$defs/Value" } },
			$defs: { Value: { anyOf: [{ type: "string" }, { type: "array", items: { $ref: "#/$defs/Value" } }] } },
		},
	};
	const call: ToolCall = { type: "toolCall", id: "recursive", name: "read", arguments: { value: [null, [8]] } };
	expect(validateToolArguments(recursive, call)).toEqual({ value: ["null", ["8"]] });
	expect(call.arguments).toEqual({ value: [null, [8]] });
	expect(() => validateToolArguments(recursive, { ...call, arguments: { value: {} } })).toThrow(
		"value: expected string, got object",
	);
});

test("large enums validate values near the end and report bounded diagnostics", () => {
	const choices = Array.from({ length: 12000 }, (_, index) => `option-${index}`);
	const select: Tool = {
		name: "select",
		description: "Select an option",
		parameters: Type.Object({ choice: Type.Unsafe({ enum: choices }) }),
	};
	const call: ToolCall = { type: "toolCall", id: "enum", name: "select", arguments: { choice: "option-11999" } };
	expect(validateToolArguments(select, call)).toEqual(call.arguments);
	expect(() => validateToolArguments(select, { ...call, arguments: { choice: "absent" } })).toThrow(
		"... and 11980 more]",
	);
});

test("optional prototype-named fields are absent unless the arguments own them", () => {
	const inspect: Tool = {
		name: "inspect",
		description: "Read explicit fields",
		parameters: Type.Object({
			toString: Type.Optional(Type.Number()),
			constructor: Type.Optional(Type.String()),
		}),
	};
	const call: ToolCall = { type: "toolCall", id: "own", name: "inspect", arguments: {} };
	expect(validateToolArguments(inspect, call)).toEqual({});
	expect(validateToolArguments(inspect, { ...call, arguments: { constructor: 17 } })).toEqual({ constructor: "17" });
	expect(() => validateToolArguments(inspect, { ...call, arguments: { toString: "invalid" } })).toThrow(
		"toString: expected number, got string",
	);
});

test("constraint diagnostics identify the field, format and required dependency", () => {
	const cases: Array<[Tool["parameters"], ToolCall["arguments"], string]> = [
		[
			Type.Object({ code: Type.String({ pattern: "^[A-Z]{2}$" }) }),
			{ code: "invalid" },
			"code: expected to match ^[A-Z]{2}$",
		],
		[Type.Object({ amount: Type.Number({ multipleOf: 3 }) }), { amount: 4 }, "amount: expected a multiple of 3"],
		[
			Type.Object({ names: Type.Array(Type.String(), { uniqueItems: true }) }),
			{ names: ["same", "same"] },
			"names: expected unique items",
		],
		// @ts-expect-error JavaScript callers can supply non-JSON byte values.
		[Type.Object({ count: Type.Integer() }), { count: new Uint8Array([1, 2]) }, "count: expected integer, got bytes"],
		...([1, 2] as const).map(
			(max) =>
				[
					{
						type: "object",
						properties: { values: { type: "array", contains: { type: "number" }, minContains: 0, maxContains: max } },
					},
					{ values: [1, 2, 3] },
					`values: expected at most ${max} matching ${max === 1 ? "item" : "items"}`,
				] satisfies [Tool["parameters"], ToolCall["arguments"], string],
		),
		[
			Type.Object({ contact: Type.String({ format: "email" }) }),
			{ contact: "invalid" },
			"contact: expected format email",
		],
		[
			{
				type: "object",
				properties: { flag: { type: "boolean" }, note: { type: "string" } },
				dependentRequired: { flag: ["note"] },
			},
			{ flag: true },
			"note: required when flag is present",
		],
		[
			{
				type: "object",
				properties: { mode: { type: "string" } },
				if: { properties: { mode: { const: "write" } } },
				then: { required: ["path"] },
			},
			{ mode: "write" },
			"path: missing",
		],
		[
			{ type: "object", propertyNames: { pattern: "^[a-z]+$" } },
			{ "Mixed-Key": 1 },
			"Mixed-Key: invalid property name",
		],
		[
			{ type: "object", properties: { items: { type: "array", contains: { type: "number" } } } },
			{ items: ["text"] },
			"items: expected at least 1 matching item",
		],
		[
			{ type: "object", properties: { label: { type: "string" } }, unevaluatedProperties: false },
			{ label: "keep", extra: false },
			"extra: unknown field",
		],
	];
	for (const [parameters, args, message] of cases) {
		const inspect: Tool = { name: "inspect", description: "Check constraints", parameters };
		const call: ToolCall = { type: "toolCall", id: "constraints", name: "inspect", arguments: args };
		expect(() => validateToolArguments(inspect, call)).toThrow(message);
		expect(call.arguments).toEqual(args);
	}
});

test("composed constraints report each relevant error once", () => {
	const cases: Array<[Tool["parameters"], ToolCall["arguments"], string[]]> = [
		[
			{
				type: "object",
				allOf: [Type.Object({ title: Type.String() }), Type.Object({ count: Type.Number() })],
				unevaluatedProperties: false,
			},
			{ title: [], count: "bad" },
			["title: expected string, got array", "count: expected number, got string"],
		],
		[
			Type.Object({
				entry: Type.Object({ ready: Type.Boolean() }, { dependentRequired: { ready: ["first", "second"] } }),
			}),
			{ entry: { ready: true } },
			["entry.first: required when ready is present", "entry.second: required when ready is present"],
		],
		[
			Type.Object({ values: Type.Unsafe({ type: "array", items: false }) }),
			{ values: [1] },
			["values.0: no value is allowed here"],
		],
		[Type.Object({ value: Type.Never() }), { value: 1 }, ["value: must not match the schema in not"]],
		[
			Type.Object({
				values: Type.Unsafe({ type: "array", prefixItems: [{ type: "number" }], unevaluatedItems: false }),
			}),
			{ values: [1, 2] },
			["values.1: unexpected item"],
		],
		[
			Type.Object({ values: Type.Array(Type.Unknown(), { contains: { type: "number" }, maxContains: 1 }) }),
			{ values: [1, 2] },
			["values: expected between 1 and 1 matching items"],
		],
	];
	for (const [parameters, args, diagnostics] of cases) {
		const inspect: Tool = { name: "inspect", description: "Check composed constraints", parameters };
		const call: ToolCall = { type: "toolCall", id: "composed", name: "inspect", arguments: args };
		expect(() => validateToolArguments(inspect, call)).toThrow(
			`Validation failed for tool "inspect":\n${diagnostics.map((message) => `  - ${message}`).join("\n")}\n\nReceived arguments:\n${JSON.stringify(args, null, 2)}`,
		);
	}
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
	expect(() => validateToolArguments(convert, { ...call, arguments: { scoped: "bad", outer: 42 } }))
		.toThrow("scoped: expected number, got string");
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
