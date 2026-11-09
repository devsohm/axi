import type { SqliteValue } from "../sqlite/index.ts";
import { invalid } from "../data/internal.ts";
import type { Columns, ColumnTypeOf, ValueOf } from "./columns.ts";
import {
	type ColumnRef,
	type Condition,
	compileWhere,
	type WhereNode,
} from "./expression.ts";
import { checkScalar } from "./rows.ts";
import type { Order } from "./sql.ts";
import type { TableDefinition } from "./table.ts";

export type ColumnRefs<C extends Columns> = {
	readonly [N in keyof C & string]: ColumnRef<
		ValueOf<C[N]>,
		ColumnTypeOf<C[N]>
	>;
};
export function query<C extends Columns, K extends readonly string[]>(
	table: TableDefinition<C, K>,
): Query<C, K> {
	return new Query(table, undefined, [], undefined);
}
export class Query<
	C extends Columns = Columns,
	K extends readonly string[] = readonly string[],
> {
	readonly table: TableDefinition<C, K>;
	readonly condition: WhereNode | undefined;
	readonly #ordered: readonly string[];
	readonly #direction: "asc" | "desc" | undefined;
	constructor(
		table: TableDefinition<C, K>,
		condition: WhereNode | undefined,
		orderBy: readonly string[],
		direction: "asc" | "desc" | undefined,
	) {
		this.table = table;
		this.condition = condition;
		this.#ordered = orderBy;
		this.#direction = direction;
	}
	where(fn: (row: ColumnRefs<C>) => Condition): Query<C, K> {
		const next = compileWhere(
			this.table,
			fn(this.table.refs as ColumnRefs<C>),
			"where",
		);
		return new Query(
			this.table,
			this.condition === undefined ? next : { and: [this.condition, next] },
			this.#ordered,
			this.#direction,
		);
	}
	orderBy(
		fn: (row: ColumnRefs<C>) => ColumnRef<unknown, "str" | "int">,
		direction: "asc" | "desc" = "asc",
	): Query<C, K> {
		const reference = fn(this.table.refs as ColumnRefs<C>);
		const column = this.table.byName.get(reference?.column ?? "");
		if (
			!column ||
			column.optional ||
			(column.type !== "str" && column.type !== "int")
		)
			throw invalid(
				"args",
				`${this.table.name}: orderBy: expected a non-opt str() or int() column`,
			);
		if (this.#ordered.includes(column.name))
			throw invalid(
				"args",
				`${this.table.name}: orderBy: "${column.name}" twice`,
			);
		if (this.#direction !== undefined && direction !== this.#direction)
			throw invalid(
				"args",
				`${this.table.name}: orderBy: one direction per query`,
			);
		return new Query(
			this.table,
			this.condition,
			[...this.#ordered, column.name],
			direction,
		);
	}
	get order(): Order {
		return {
			columns: [
				...this.#ordered,
				...this.table.key.filter((name) => !this.#ordered.includes(name)),
			],
			direction: this.#direction ?? "asc",
		};
	}
}
export function encodeCursor(
	table: string,
	order: Order,
	values: readonly SqliteValue[],
): string {
	const bytes = new TextEncoder().encode(
		JSON.stringify({
			t: table,
			o: order.columns,
			d: order.direction,
			v: values,
		}),
	);
	return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
}
export function decodeCursor(
	table: TableDefinition,
	sqlName: string,
	order: Order,
	cursor: unknown,
): SqliteValue[] {
	const refuse = (): never => {
		throw invalid(
			"args",
			`${table.name}: the cursor is not one of this table's order`,
		);
	};
	if (typeof cursor !== "string") return refuse();
	let value: unknown;
	try {
		const bytes = Uint8Array.from(
			atob(cursor.replaceAll("-", "+").replaceAll("_", "/")),
			(char) => char.charCodeAt(0),
		);
		value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		return refuse();
	}
	if (value === null || typeof value !== "object") return refuse();
	const t: unknown = Reflect.get(value, "t"),
		d: unknown = Reflect.get(value, "d"),
		o: unknown = Reflect.get(value, "o"),
		v: unknown = Reflect.get(value, "v");
	if (
		t !== sqlName ||
		d !== order.direction ||
		JSON.stringify(o) !== JSON.stringify(order.columns) ||
		!Array.isArray(v) ||
		v.length !== order.columns.length
	)
		return refuse();
	return order.columns.map((name, index) => {
		const column = table.byName.get(name)!;
		return column.type === "str"
			? checkScalar("str", v[index], `${table.name}: cursor`)
			: checkScalar("int", v[index], `${table.name}: cursor`);
	});
}
