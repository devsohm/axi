import type { TBoolean, TInteger, TNumber, TOptional, TString } from "typebox";
import type { KindShape, Static, TSchema } from "../contracts/index.ts";
import { HostColumn, type HostColumnSchema } from "./host-column.ts";
import { JsonColumn, type JsonColumnSchema } from "./json-column.ts";
import { storedText } from "./text.ts";

type ScalarSchema = TString | TInteger | TNumber | TBoolean;
export type ColumnSchema =
	| ScalarSchema
	| JsonColumnSchema<unknown>
	| (HostColumnSchema<KindShape> & { readonly "~optional"?: never })
	| TOptional<ScalarSchema | JsonColumnSchema<unknown>>;
export type Columns = { readonly [name: string]: ColumnSchema };
export type ColumnType = "str" | "int" | "num" | "bool" | "json";
export type ColumnTypeOf<S> = S extends TOptional<infer Inner>
	? ColumnTypeOf<Inner>
	: S extends HostColumnSchema<KindShape>
		? "str"
		: S extends TString
			? "str"
			: S extends TInteger
				? "int"
				: S extends TNumber
					? "num"
					: S extends TBoolean
						? "bool"
						: "json";
export type ValueOf<S> = S extends TOptional<infer Inner>
	? ValueOf<Inner>
	: S extends TSchema
		? Static<S>
		: never;
type Required<C extends Columns> = {
	[K in keyof C]: C[K] extends TOptional<TSchema> ? never : K;
}[keyof C];
type Defaulted<C extends Columns> = {
	[K in keyof C]: C[K] extends { readonly default: unknown } ? K : never;
}[keyof C];
export type RowOf<C extends Columns> = { [K in Required<C>]: ValueOf<C[K]> } & {
	[K in Exclude<keyof C, Required<C>>]?: ValueOf<C[K]>;
};
export type PutRowOf<C extends Columns> = {
	[K in Exclude<Required<C>, Defaulted<C>>]: ValueOf<C[K]>;
} & {
	[K in Exclude<keyof C, Exclude<Required<C>, Defaulted<C>>>]?: ValueOf<C[K]>;
};
export type OrderColumn<C extends Columns> = {
	[K in keyof C]: C[K] extends TString | TInteger | HostColumnSchema<KindShape>
		? C[K] extends TOptional<TSchema>
			? never
			: K
		: never;
}[keyof C] &
	string;
export type Column =
	| {
			readonly name: string;
			readonly type: "str" | "int" | "num" | "bool";
			readonly optional: boolean;
			readonly default: string | number | boolean | undefined;
			readonly host?: HostColumn;
	  }
	| {
			readonly name: string;
			readonly type: "json";
			readonly optional: boolean;
			readonly json: JsonColumn;
	  };
export type ScalarColumn = Exclude<Column, { readonly type: "json" }>;
export type HostColumnOf = ScalarColumn & { readonly type: "str"; readonly host: HostColumn };
export type ColumnRecord = {
	readonly type: ColumnType;
	readonly optional?: true;
	readonly default?: string | number | boolean;
	readonly version?: number;
	readonly fingerprint?: string;
	readonly host?: string;
};
export const COLUMN_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
export function checkColumnName(name: string, what: string): void {
	if (!COLUMN_NAME.test(name))
		throw new Error(
			`${what}: column "${name}": expected [A-Za-z_][A-Za-z0-9_]*`,
		);
}
export function describeColumns(columns: Columns, table: string): Column[] {
	const seen = new Set<string>();
	return Object.entries(columns).map(([name, schema]) => {
		checkColumnName(name, table);
		const folded = name.toLowerCase();
		if (seen.has(folded))
			throw new Error(
				`${table}: column "${name}" differs from another only in case`,
			);
		seen.add(folded);
		const what = `${table}: column "${name}"`;
		const optional = Object.hasOwn(schema, "~optional");
		const json: unknown = Reflect.get(schema, "json");
		if (json instanceof JsonColumn)
			return { name, type: "json", optional, json };
		const host: unknown = Reflect.get(schema, "host");
		if (host instanceof HostColumn) {
			if (optional) throw new Error(`${what}: a host(...) column is not opt(...)`);
			return { name, type: "str", optional: false, default: undefined, host };
		}
		const type = scalarType(Reflect.get(schema, "type"), what);
		for (const key of Object.keys(schema))
			if (key !== "type" && key !== "default")
				throw new Error(`${what}: "${key}" is not supported in a table column`);
		const value: unknown = Reflect.get(schema, "default");
		if (value === undefined)
			return { name, type, optional, default: undefined };
		if (optional) throw new Error(`${what}: an opt(...) column has no default`);
		if (
			(typeof value === "string" &&
				type === "str" &&
				storedText(value, what) === value) ||
			(type === "int" &&
				typeof value === "number" &&
				Number.isSafeInteger(value)) ||
			(type === "num" && typeof value === "number" && Number.isFinite(value)) ||
			(type === "bool" && typeof value === "boolean")
		)
			return { name, type, optional, default: value };
		throw new Error(
			`${what}: the default ${JSON.stringify(value)} is not a ${type} value`,
		);
	});
}
function scalarType(
	value: unknown,
	what: string,
): "str" | "int" | "num" | "bool" {
	switch (String(value)) {
		case "string":
			return "str";
		case "integer":
			return "int";
		case "number":
			return "num";
		case "boolean":
			return "bool";
		default:
			throw new Error(
				`${what}: expected str(), int(), num(), bool(), opt(...) or json(...)`,
			);
	}
}
export function columnRecord(column: Column): ColumnRecord {
	if (column.type !== "json" && column.host !== undefined) return { type: "str", host: column.host.kind.kind };
	const record: ColumnRecord = {
		type: column.type,
		...(column.optional ? { optional: true as const } : {}),
	};
	return column.type === "json"
		? {
				...record,
				version: column.json.version,
				fingerprint: column.json.fingerprint,
			}
		: column.default === undefined
			? record
			: { ...record, default: column.default };
}
