import { Type } from "typebox";
import { expectTypeOf } from "vitest";
import type { Tool } from "@axi/ai";
import { defineTool, type ToolRegistration } from "../src/index.ts";

type Fields = {
	title: { "~kind": "String"; type: "string" };
	limit: { "~kind": "Integer"; type: "integer"; "~optional": true };
	checks: {
		"~kind": "Array";
		type: "array";
		items: {
			"~kind": "Object";
			type: "object";
			properties: { enabled: { "~kind": "Boolean"; type: "boolean" } };
			required: string[];
		};
	};
};

type ParametersSchema = { "~kind": "Object"; type: "object"; properties: Fields; required: string[] };
type Arguments = { title: string; limit?: number; checks: { enabled: boolean }[] };
type Args<P extends object> = Parameters<ToolRegistration<P>["execute"]>[0];

export function checkToolArguments(parameters: ParametersSchema): void {
	const tool = defineTool({
		name: "check",
		description: "Check named items",
		parameters,
		async execute(args) {
			expectTypeOf(args).toEqualTypeOf<Arguments>();
			return {};
		},
		async cancel(args) {
			expectTypeOf(args).toEqualTypeOf<Arguments>();
		},
	});
	expectTypeOf<Parameters<typeof tool.execute>[0]>().toEqualTypeOf<Arguments>();
	expectTypeOf<
		ReturnType<NonNullable<ToolRegistration<ParametersSchema>["prepareArguments"]>>
	>().toEqualTypeOf<Arguments>();

	const built = defineTool({
		name: "select",
		description: "Select a label",
		parameters: Type.Object({
			label: Type.Readonly(Type.Optional(Type.String())),
			value: Type.Union([Type.String(), Type.Number()]),
		}),
		async execute(args) {
			expectTypeOf(args).toEqualTypeOf<{ readonly label?: string; value: string | number }>();
			return {};
		},
	});
	expectTypeOf<Parameters<typeof built.execute>[0]>().toEqualTypeOf<{
		readonly label?: string;
		value: string | number;
	}>();
	expectTypeOf<Parameters<ToolRegistration<any>["execute"]>[0]>().toBeAny();
	expectTypeOf<
		Args<{ "~kind": "Union"; anyOf: [ParametersSchema, { "~kind": "Null"; type: "null" }] }>
	>().toEqualTypeOf<Arguments | null>();
	expectTypeOf<
		Args<{
			"~kind": "Tuple";
			type: "array";
			items: [ParametersSchema, { "~kind": "String"; type: "string"; "~optional": true }];
			additionalItems: false;
		}>
	>().toEqualTypeOf<[Arguments, string]>();
	expectTypeOf<
		Args<{ "~kind": "Record"; type: "object"; patternProperties: { "^.*$": ParametersSchema } }>
	>().toEqualTypeOf<Record<string, Arguments>>();
	expectTypeOf<Args<{ type: "string" }>>().toBeUnknown();
	expectTypeOf<Args<{ "~kind": "Never"; not: {} }>>().toBeUnknown();
	expectTypeOf<Args<{ "~kind": "Rest"; type: "rest"; items: ParametersSchema }>>().toBeUnknown();
	expectTypeOf<Args<{ "~unsafe": { selected: number } }>>().toEqualTypeOf<{ selected: number }>();
	const patterned = Type.Record(Type.TemplateLiteral(["part-", Type.Number()]), Type.Boolean());
	expectTypeOf<Args<typeof patterned>>().toEqualTypeOf<Record<string, boolean>>();
	const numeric = Type.Record(Type.Integer(), Type.Number());
	expectTypeOf<Args<typeof numeric>>().toEqualTypeOf<Record<number, number>>();
	// @ts-expect-error Tool parameter schemas must be objects.
	expectTypeOf<ToolRegistration<number>>();
	// @ts-expect-error AI tool schemas also require objects.
	expectTypeOf<Tool<boolean>>();
	// @ts-expect-error The inferred definition must reject primitive schemas.
	defineTool({ name: "invalid", description: "Invalid schema", parameters: 42, execute: async () => ({}) });
}
