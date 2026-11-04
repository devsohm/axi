import type { SqliteValue } from "../../sqlite/index.ts";
import type { Column, ColumnRecord } from "./columns.ts";
import type { ExprNode, SetNode, WhereNode } from "./expression.ts";
import {
	physicalColumns,
	ROW_VERSION,
	toSqlite,
	versionColumn,
} from "./rows.ts";
import { prefixUpperBound } from "./text.ts";

export type Statement = {
	readonly sql: string;
	readonly params: SqliteValue[];
};
export type Order = {
	readonly columns: readonly string[];
	readonly direction: "asc" | "desc";
};
export function quote(name: string): string {
	return `"${name}"`;
}
export function tableSqlName(owner: string, table: string): string {
	return [owner, table].join(":");
}
const names = (columns: readonly string[]): string =>
	columns.map(quote).join(", ");
const marks = (columns: readonly unknown[]): string =>
	columns.map(() => "?").join(", ");
function literal(value: string | number | boolean): string {
	return typeof value === "string"
		? `'${value.replaceAll("'", "''")}'`
		: typeof value === "boolean"
			? String(Number(value))
			: String(value);
}
export function columnSql(name: string, column: ColumnRecord): string[] {
	const label = quote(name),
		required = column.optional ? "" : " NOT NULL";
	const fallback =
		column.default === undefined ? "" : ` DEFAULT ${literal(column.default)}`;
	if (column.type === "json")
		return [
			`${label} TEXT${required}`,
			`${quote(versionColumn(name))} INTEGER${required}`,
		];
	const storage =
		column.type === "str" ? "TEXT" : column.type === "num" ? "REAL" : "INTEGER";
	const check =
		column.type === "bool"
			? ` CHECK (${label} IN (0, 1))`
			: column.type === "int"
				? ` CHECK (${label} BETWEEN ${-Number.MAX_SAFE_INTEGER} AND ${Number.MAX_SAFE_INTEGER})`
				: "";
	return [`${label} ${storage}${required}${fallback}${check}`];
}
export function createTableSql(
	table: string,
	columns: Readonly<Record<string, ColumnRecord>>,
	key: readonly string[],
): string {
	const declarations: string[] = [];
	for (const [name, column] of Object.entries(columns))
		declarations.push(...columnSql(name, column));
	declarations.push(
		`${quote(ROW_VERSION)} INTEGER NOT NULL`,
		`PRIMARY KEY (${names(key)})`,
	);
	const suffix =
		key.length === 1 && columns[key[0]!]!.type === "int"
			? ""
			: ", WITHOUT ROWID";
	return `CREATE TABLE ${quote(table)} (${declarations.join(", ")}) STRICT${suffix}`;
}
function putSql(table: string, physical: readonly string[]): string {
	return `INSERT OR REPLACE INTO ${quote(table)} (${names(physical)}) VALUES (${marks(physical)})`;
}
export function recordedPut(
	table: string,
	columns: Readonly<Record<string, ColumnRecord>>,
): { readonly physical: readonly string[]; readonly sql: string } {
	const physical = physicalColumns(
		Object.entries(columns).map(([name, column]) => ({
			name,
			type: column.type,
		})),
	);
	return { physical, sql: putSql(table, physical) };
}
export function createIndexSql(
	table: string,
	index: string,
	columns: readonly string[],
	key: readonly string[],
): string {
	const ordered = new Set([...columns, ...key]);
	return `CREATE INDEX ${quote(`${table}:${index}`)} ON ${quote(table)} (${names([...ordered])})`;
}
export function dropIndexSql(table: string, index: string): string {
	return `DROP INDEX ${quote(`${table}:${index}`)}`;
}

class SqlWriter {
	readonly params: SqliteValue[];
	constructor(params: SqliteValue[] = []) {
		this.params = params;
	}
	bind(value: SqliteValue): string {
		this.params.push(value);
		return "?";
	}
	where(node: WhereNode): string {
		if ("and" in node)
			return node.and.length
				? `(${node.and.map((item) => this.where(item)).join(" AND ")})`
				: "1";
		if ("or" in node)
			return node.or.length
				? `(${node.or.map((item) => this.where(item)).join(" OR ")})`
				: "0";
		if ("not" in node) return `(NOT ${this.where(node.not)})`;
		if ("isNull" in node) return `${quote(node.isNull)} IS NULL`;
		if ("inArray" in node)
			return `${quote(node.inArray[0])} IN (SELECT value FROM json_each(${this.bind(JSON.stringify(node.inArray[1].map(toSqlite)))}))`;
		if ("prefix" in node) {
			const [column, prefix] = node.prefix,
				upper = prefixUpperBound(prefix);
			const lower = `${quote(column)} >= ${this.bind(prefix)}`;
			return upper === undefined
				? lower
				: `(${lower} AND ${quote(column)} < ${this.bind(upper)})`;
		}
		const compare = (
			op: string,
			pair: readonly [string, string | number | boolean],
		): string => `${quote(pair[0])} ${op} ${this.bind(toSqlite(pair[1]))}`;
		if ("eq" in node) return compare("=", node.eq);
		if ("ne" in node) return compare("<>", node.ne);
		if ("lt" in node) return compare("<", node.lt);
		if ("lte" in node) return compare("<=", node.lte);
		if ("gt" in node) return compare(">", node.gt);
		return compare(">=", node.gte);
	}
	expr(node: ExprNode): string {
		if (node === null) return "NULL";
		if (typeof node !== "object") return this.bind(toSqlite(node));
		if ("col" in node) return quote(node.col);
		if ("json" in node) return this.bind(JSON.stringify(node.json));
		if ("when" in node)
			return `(CASE WHEN ${this.where(node.when[0])} THEN ${this.expr(node.when[1])} ELSE ${this.expr(node.when[2])} END)`;
		if ("replacePrefix" in node) {
			const [subject, from, to] = node.replacePrefix,
				length = Array.from(from).length;
			const prefix = `substr(${this.expr(subject)}, 1, ${this.bind(length)}) = ${this.bind(from)}`;
			const replacement = `${this.bind(to)} || substr(${this.expr(subject)}, ${this.bind(length + 1)})`;
			return `(CASE WHEN ${prefix} THEN ${replacement} ELSE ${this.expr(subject)} END)`;
		}
		const infix = (
			pair: readonly [ExprNode, ExprNode],
			operator: string,
		): string => `(${this.expr(pair[0])} ${operator} ${this.expr(pair[1])})`;
		const call = (name: string, pair: readonly [ExprNode, ExprNode]): string =>
			`${name}(${this.expr(pair[0])}, ${this.expr(pair[1])})`;
		if ("add" in node) return infix(node.add, "+");
		if ("sub" in node) return infix(node.sub, "-");
		if ("concat" in node) return infix(node.concat, "||");
		if ("min" in node) return call("min", node.min);
		if ("max" in node) return call("max", node.max);
		return call("coalesce", node.coalesce);
	}
	set(set: SetNode, versions: ReadonlyMap<string, number>): string {
		const sql: string[] = [];
		for (const [name, expression] of Object.entries(set)) {
			sql.push(`${quote(name)} = ${this.expr(expression)}`);
			const version = versions.get(name);
			if (version !== undefined)
				sql.push(
					`${quote(versionColumn(name))} = ${this.bind(expression === null ? null : version)}`,
				);
		}
		return sql.join(", ");
	}
}
export function whereSql(node: WhereNode, params: SqliteValue[]): string {
	return new SqlWriter(params).where(node);
}
export class TableSql {
	readonly table: string;
	readonly put: string;
	readonly get: string;
	readonly delete: string;
	readonly #columns: string;
	readonly #key: string;
	constructor(
		table: string,
		columns: readonly Pick<Column, "name" | "type">[],
		physical: readonly string[],
		key: readonly string[],
	) {
		this.table = table;
		this.#key = key.map((name) => `${quote(name)} = ?`).join(" AND ");
		this.#columns = names([
			...columns.map((column) => column.name),
			...columns
				.filter((column) => column.type === "json")
				.map((column) => versionColumn(column.name)),
		]);
		this.put = putSql(table, physical);
		this.get = `SELECT ${this.#columns} FROM ${quote(table)} WHERE ${this.#key}`;
		this.delete = `DELETE FROM ${quote(table)} WHERE ${this.#key}`;
	}
	getColumns(columns: readonly string[]): string {
		return `SELECT ${names(columns)} FROM ${quote(this.table)} WHERE ${this.#key}`;
	}
	update(
		set: SetNode,
		key: readonly SqliteValue[],
		versions: ReadonlyMap<string, number>,
	): Statement {
		const writer = new SqlWriter(),
			assignments = writer.set(set, versions);
		writer.params.push(...key);
		return {
			sql: `UPDATE ${quote(this.table)} SET ${assignments} WHERE ${this.#key}`,
			params: writer.params,
		};
	}
	updateWhere(
		where: WhereNode,
		set: SetNode,
		versions: ReadonlyMap<string, number>,
	): Statement {
		const writer = new SqlWriter(),
			assignments = writer.set(set, versions),
			condition = writer.where(where);
		return {
			sql: `UPDATE ${quote(this.table)} SET ${assignments} WHERE ${condition}`,
			params: writer.params,
		};
	}
	deleteWhere(where: WhereNode): Statement {
		const writer = new SqlWriter(),
			condition = writer.where(where);
		return {
			sql: `DELETE FROM ${quote(this.table)} WHERE ${condition}`,
			params: writer.params,
		};
	}
	select(
		where: WhereNode | undefined,
		order: Order,
		after: readonly SqliteValue[] | undefined,
		limit: number,
		columns?: readonly string[],
	): Statement {
		const writer = new SqlWriter(),
			conditions: string[] = [];
		if (where !== undefined) conditions.push(writer.where(where));
		if (after !== undefined)
			conditions.push(
				`(${names(order.columns)}) ${order.direction === "asc" ? ">" : "<"} (${after.map((value) => writer.bind(value)).join(", ")})`,
			);
		const filter = conditions.length
			? ` WHERE ${conditions.join(" AND ")}`
			: "";
		const ordering = order.columns
			.map((name) => `${quote(name)} ${order.direction.toUpperCase()}`)
			.join(", ");
		const sql = `SELECT ${columns === undefined ? this.#columns : names(columns)} FROM ${quote(this.table)}${filter} ORDER BY ${ordering} LIMIT ${writer.bind(limit)}`;
		return { sql, params: writer.params };
	}
	count(where: WhereNode | undefined): Statement {
		const writer = new SqlWriter(),
			filter = where === undefined ? "" : ` WHERE ${writer.where(where)}`;
		return {
			sql: `SELECT count(*) AS count FROM ${quote(this.table)}${filter}`,
			params: writer.params,
		};
	}
}
