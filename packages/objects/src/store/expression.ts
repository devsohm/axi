import type { TOptional } from "typebox";
import type { JsonValue } from "../json.ts";
import type { TSchema } from "../contracts/index.ts";
import { invalid } from "../data/internal.ts";
import type {
	Column,
	Columns,
	ColumnType,
	ColumnTypeOf,
	ValueOf,
} from "./columns.ts";
import { checkScalar, encodeCell, type Scalar } from "./rows.ts";
import type { TableDefinition } from "./table.ts";

export type Comparison = "eq" | "ne" | "lt" | "lte" | "gt" | "gte";
export type Operation =
	| "add"
	| "sub"
	| "max"
	| "min"
	| "concat"
	| "coalesce"
	| "replacePrefix"
	| "when";
export type WhereNode =
	| { readonly eq: readonly [string, Scalar] }
	| { readonly ne: readonly [string, Scalar] }
	| { readonly lt: readonly [string, Scalar] }
	| { readonly lte: readonly [string, Scalar] }
	| { readonly gt: readonly [string, Scalar] }
	| { readonly gte: readonly [string, Scalar] }
	| { readonly inArray: readonly [string, readonly Scalar[]] }
	| { readonly isNull: string }
	| { readonly prefix: readonly [string, string] }
	| { readonly and: readonly WhereNode[] }
	| { readonly or: readonly WhereNode[] }
	| { readonly not: WhereNode };
export type ExprNode =
	| Scalar
	| null
	| { readonly col: string }
	| { readonly json: JsonValue }
	| { readonly add: readonly [ExprNode, ExprNode] }
	| { readonly sub: readonly [ExprNode, ExprNode] }
	| { readonly max: readonly [ExprNode, ExprNode] }
	| { readonly min: readonly [ExprNode, ExprNode] }
	| { readonly concat: readonly [ExprNode, ExprNode] }
	| { readonly coalesce: readonly [ExprNode, ExprNode] }
	| { readonly replacePrefix: readonly [ExprNode, string, string] }
	| { readonly when: readonly [WhereNode, ExprNode, ExprNode] };
export type SetNode = { readonly [column: string]: ExprNode };
type ScalarType = Exclude<ColumnType, "json">;
type ScalarColumn = Exclude<Column, { readonly type: "json" }>;
type Operand<T, K extends ColumnType> = T | Expression<T, K>;

export class Expression<T = unknown, K extends ColumnType = ColumnType> {
	declare readonly "~value"?: T;
	declare readonly "~type"?: K;
	readonly op: Operation | "col";
	readonly args: readonly unknown[];
	constructor(op: Operation | "col", args: readonly unknown[]) {
		this.op = op;
		this.args = args;
	}
}
export class ColumnRef<
	T = unknown,
	K extends ColumnType = ColumnType,
> extends Expression<T, K> {
	readonly column: string;
	constructor(column: string) {
		super("col", [column]);
		this.column = column;
	}
}
export class Condition {
	readonly op:
		| Comparison
		| "inArray"
		| "isNull"
		| "prefix"
		| "and"
		| "or"
		| "not";
	readonly args: readonly unknown[];
	constructor(op: Condition["op"], args: readonly unknown[]) {
		this.op = op;
		this.args = args;
	}
}
export type SetOf<C extends Columns, K extends readonly string[]> = {
	readonly [P in Exclude<
		keyof C & string,
		K[number]
	>]?: C[P] extends TOptional<TSchema>
		? ValueOf<C[P]> | Expression<ValueOf<C[P]>, ColumnTypeOf<C[P]>> | undefined
		: ValueOf<C[P]> | Expression<ValueOf<C[P]>, ColumnTypeOf<C[P]>>;
};

export function eq<T extends Scalar>(
	column: ColumnRef<T, ScalarType>,
	value: T,
): Condition {
	return new Condition("eq", [column, value]);
}
export function ne<T extends Scalar>(
	column: ColumnRef<T, ScalarType>,
	value: T,
): Condition {
	return new Condition("ne", [column, value]);
}
export function lt<T extends Scalar>(
	column: ColumnRef<T, ScalarType>,
	value: T,
): Condition {
	return new Condition("lt", [column, value]);
}
export function lte<T extends Scalar>(
	column: ColumnRef<T, ScalarType>,
	value: T,
): Condition {
	return new Condition("lte", [column, value]);
}
export function gt<T extends Scalar>(
	column: ColumnRef<T, ScalarType>,
	value: T,
): Condition {
	return new Condition("gt", [column, value]);
}
export function gte<T extends Scalar>(
	column: ColumnRef<T, ScalarType>,
	value: T,
): Condition {
	return new Condition("gte", [column, value]);
}
export function inArray<T extends Scalar>(
	column: ColumnRef<T, ScalarType>,
	values: readonly T[],
): Condition {
	return new Condition("inArray", [column, values]);
}
export function isNull(column: ColumnRef<unknown, ScalarType>): Condition {
	return new Condition("isNull", [column]);
}
export function prefix(
	column: ColumnRef<string, "str">,
	value: string,
): Condition {
	return new Condition("prefix", [column, value]);
}
export function and(...conditions: Condition[]): Condition {
	return new Condition("and", conditions);
}
export function or(...conditions: Condition[]): Condition {
	return new Condition("or", conditions);
}
export function not(condition: Condition): Condition {
	return new Condition("not", [condition]);
}
export function add(
	a: Operand<number, "int">,
	b: Operand<number, "int">,
): Expression<number, "int"> {
	return new Expression("add", [a, b]);
}
export function sub(
	a: Operand<number, "int">,
	b: Operand<number, "int">,
): Expression<number, "int"> {
	return new Expression("sub", [a, b]);
}
export function max<K extends "int" | "num">(
	a: Operand<number, K>,
	b: Operand<number, K>,
): Expression<number, K> {
	return new Expression("max", [a, b]);
}
export function min<K extends "int" | "num">(
	a: Operand<number, K>,
	b: Operand<number, K>,
): Expression<number, K> {
	return new Expression("min", [a, b]);
}
export function concat(
	a: Operand<string, "str">,
	b: Operand<string, "str">,
): Expression<string, "str"> {
	return new Expression("concat", [a, b]);
}
export function replacePrefix(
	value: Operand<string, "str">,
	from: string,
	to: string,
): Expression<string, "str"> {
	return new Expression("replacePrefix", [value, from, to]);
}
export function coalesce<T, K extends ScalarType>(
	a: Expression<T, K>,
	b: Operand<T, K>,
): Expression<T, K> {
	return new Expression("coalesce", [a, b]);
}
export function when<T, K extends ScalarType>(
	condition: Condition,
	a: Operand<T, K>,
	b: Operand<T, K>,
): Expression<T, K> {
	return new Expression("when", [condition, a, b]);
}
export function columnRefs(
	columns: readonly Column[],
): Record<string, ColumnRef> {
	return Object.fromEntries(
		columns.map((column) => [column.name, new ColumnRef(column.name)]),
	);
}

function scalarColumn(
	table: TableDefinition,
	ref: unknown,
	what: string,
): ScalarColumn {
	if (!(ref instanceof ColumnRef))
		throw invalid(
			"args",
			`${table.name}: ${what}: expected a column reference`,
		);
	const column = table.byName.get(ref.column);
	if (!column)
		throw invalid("args", `${table.name}: ${what}: no column "${ref.column}"`);
	if (column.type === "json")
		throw invalid(
			"args",
			`${table.name}: ${what}: json(...) column "${ref.column}" is not queryable`,
		);
	return column;
}
function operand(column: ScalarColumn, value: unknown, what: string): Scalar {
	if (value == null)
		throw invalid(
			"args",
			`${what}: column "${column.name}" compared with ${String(value)}; ask with isNull`,
		);
	return checkScalar(column.type, value, `${what}: column "${column.name}"`);
}
function stringOperand(value: unknown, what: string): string {
	return checkScalar("str", value, what);
}
export function compileWhere(
	table: TableDefinition,
	condition: unknown,
	what: string,
): WhereNode {
	if (!(condition instanceof Condition))
		throw invalid("args", `${table.name}: ${what}: expected a condition`);
	const { op, args } = condition;
	if (op === "and")
		return { and: args.map((part) => compileWhere(table, part, what)) };
	if (op === "or")
		return { or: args.map((part) => compileWhere(table, part, what)) };
	if (op === "not") return { not: compileWhere(table, args[0], what) };
	const column = scalarColumn(table, args[0], what);
	if (op === "isNull") return { isNull: column.name };
	if (op === "prefix") {
		if (column.type !== "str")
			throw invalid(
				"args",
				`${table.name}: ${what}: prefix needs a str() column`,
			);
		return { prefix: [column.name, String(operand(column, args[1], what))] };
	}
	if (op === "inArray") {
		if (!Array.isArray(args[1]))
			throw invalid("args", `${table.name}: ${what}: inArray needs an array`);
		return {
			inArray: [
				column.name,
				args[1].map((part: unknown) => operand(column, part, what)),
			],
		};
	}
	const pair: readonly [string, Scalar] = [
		column.name,
		operand(column, args[1], what),
	];
	switch (op) {
		case "eq":
			return { eq: pair };
		case "ne":
			return { ne: pair };
		case "lt":
			return { lt: pair };
		case "lte":
			return { lte: pair };
		case "gt":
			return { gt: pair };
		case "gte":
			return { gte: pair };
	}
}
type Compiled = { readonly node: ExprNode; readonly nullable: boolean };
function compileExpr(
	table: TableDefinition,
	value: unknown,
	type: ScalarType,
	what: string,
): Compiled {
	const refuse = (message: string): never => {
		throw invalid("args", `${table.name}: ${what}: ${message}`);
	};
	if (!(value instanceof Expression))
		return value == null
			? { node: null, nullable: true }
			: {
					node: checkScalar(type, value, `${table.name}: ${what}`),
					nullable: false,
				};
	const { op, args } = value;
	if (op === "col") {
		const column =
			typeof args[0] === "string" ? table.byName.get(args[0]) : undefined;
		if (!column) return refuse(`no column "${String(args[0])}"`);
		if (column.type !== type)
			return refuse(`column "${column.name}" is ${column.type}, not ${type}`);
		return { node: { col: column.name }, nullable: column.optional };
	}
	if (op === "replacePrefix") {
		if (type !== "str")
			return refuse(`replacePrefix gives str, the column is ${type}`);
		const subject = compileExpr(table, args[0], type, what);
		return {
			node: {
				replacePrefix: [
					subject.node,
					stringOperand(args[1], `${table.name}: ${what}`),
					stringOperand(args[2], `${table.name}: ${what}`),
				],
			},
			nullable: subject.nullable,
		};
	}
	if (op === "when") {
		const condition = compileWhere(table, args[0], what);
		const left = compileExpr(table, args[1], type, what),
			right = compileExpr(table, args[2], type, what);
		return {
			node: { when: [condition, left.node, right.node] },
			nullable: left.nullable || right.nullable,
		};
	}
	const permitted =
		op === "coalesce" ||
		(op === "concat"
			? type === "str"
			: op === "add" || op === "sub"
				? type === "int"
				: type === "int" || type === "num");
	if (!permitted)
		return refuse(
			`${op} gives ${op === "concat" ? "str" : op === "add" || op === "sub" ? "int" : "int or num"}, the column is ${type}`,
		);
	const left = compileExpr(table, args[0], type, what),
		right = compileExpr(table, args[1], type, what);
	const pair: readonly [ExprNode, ExprNode] = [left.node, right.node];
	const nullable = left.nullable || right.nullable;
	switch (op) {
		case "coalesce":
			return {
				node: { coalesce: pair },
				nullable: left.nullable && right.nullable,
			};
		case "add":
			return { node: { add: pair }, nullable };
		case "sub":
			return { node: { sub: pair }, nullable };
		case "max":
			return { node: { max: pair }, nullable };
		case "min":
			return { node: { min: pair }, nullable };
		case "concat":
			return { node: { concat: pair }, nullable };
	}
}
export function compileSet(
	table: TableDefinition,
	set: unknown,
	what: string,
): SetNode {
	if (!set || typeof set !== "object" || Array.isArray(set))
		throw invalid(
			"args",
			`${table.name}: ${what}: expected an object of column values`,
		);
	const entries = Object.entries(set);
	if (!entries.length)
		throw invalid("args", `${table.name}: ${what}: the set is empty`);
	const result: Record<string, ExprNode> = {};
	for (const [name, value] of entries) {
		const column = table.byName.get(name);
		if (!column)
			throw invalid("args", `${table.name}: ${what}: no column "${name}"`);
		if (table.key.includes(name))
			throw invalid(
				"args",
				`${table.name}: ${what}: key column "${name}" cannot change (delete and put)`,
			);
		const location = `${what}: column "${name}"`;
		if (value === undefined) {
			if (!column.optional)
				throw invalid(
					"args",
					`${table.name}: ${location} is not opt(...) and cannot be cleared`,
				);
			result[name] = null;
		} else if (value === null && column.type !== "json") {
			throw invalid(
				"args",
				`${table.name}: ${location}: null is no ${column.type} value (undefined clears)`,
			);
		} else if (value instanceof Expression) {
			if (column.type === "json")
				throw invalid(
					"args",
					`${table.name}: ${location}: json(...) columns take plain values`,
				);
			const expression = compileExpr(table, value, column.type, location);
			if (expression.nullable && !column.optional)
				throw invalid(
					"args",
					`${table.name}: ${location}: the expression may be NULL; the column is not opt(...)`,
				);
			result[name] = expression.node;
		} else
			result[name] =
				column.type === "json"
					? {
							json: encodeCell(column, value, `${table.name}: ${location}`)
								.stored,
						}
					: checkScalar(column.type, value, `${table.name}: ${location}`);
	}
	return result;
}
