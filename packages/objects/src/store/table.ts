import { checkName } from "../contracts/names.ts";
import type { Address, KindShape } from "../contracts/index.ts";
import type { HostColumnSchema } from "./host-column.ts";
import { hash64 } from "../contracts/fingerprint.ts";
import {
	columnRecord,
	describeColumns,
	type Column,
	type ColumnRecord,
	type Columns,
	type HostColumnOf,
	type OrderColumn,
} from "./columns.ts";
import { columnRefs, type ColumnRef } from "./expression.ts";
import { RowCodec } from "./rows.ts";
import type { Migration } from "./table-history.ts";

export type TableOptions<
	C extends Columns,
	K extends readonly OrderColumn<C>[],
	V extends number = number,
> = {
	readonly version: V;
	readonly columns: C;
	readonly key: K;
	readonly indexes?: { readonly [name: string]: readonly OrderColumn<C>[] };
};
export type KeyOf<C extends Columns, K extends readonly string[]> = {
	readonly [P in K[number]]: P extends keyof C
		? C[P] extends HostColumnSchema<infer H extends KindShape>
			? Address<H>
			: C[P] extends { readonly "~kind": "Integer" }
				? number
				: string
		: never;
};
export type Evolution = {
	readonly previous: TableDefinition;
	readonly migration: Migration;
};
export const TABLE_FORM_VERSION = 1;
export const INDEX_NAME = /^[a-z0-9_]+$/;
export const HOST_INDEX = "host";
export function defineTable<
	C extends Columns,
	const K extends readonly OrderColumn<C>[],
	const V extends number,
>(name: string, options: TableOptions<C, K, V>): TableDefinition<C, K, V> {
	return new TableDefinition(name, options);
}
export class TableDefinition<
	C extends Columns = Columns,
	K extends readonly string[] = readonly string[],
	V extends number = number,
> {
	readonly name: string;
	readonly evolution: Evolution | undefined;
	readonly version: V;
	readonly schemas: Columns;
	readonly columns: readonly Column[];
	readonly byName: ReadonlyMap<string, Column>;
	readonly key: readonly string[];
	readonly indexes: ReadonlyMap<string, readonly string[]>;
	readonly record: Readonly<Record<string, ColumnRecord>>;
	readonly fingerprint: string;
	readonly rows: RowCodec;
	readonly refs: Readonly<Record<string, ColumnRef>>;
	readonly hostColumn: HostColumnOf | undefined;
	declare readonly "~columns"?: C;
	declare readonly "~key"?: K;
	constructor(
		name: string,
		options: TableOptions<C, K & readonly OrderColumn<C>[], V>,
		evolution?: Evolution,
	) {
		checkName(name, "table");
		const { version, columns, key, indexes: declaredIndexes = {} } = options;
		this.name = name;
		this.evolution = evolution;
		if (!Number.isSafeInteger(version) || version < 1)
			throw new Error(
				`${name}: version ${version} is not a positive integer`,
			);
		this.version = version;
		this.schemas = columns;
		this.columns = describeColumns(columns, name);
		this.byName = new Map(this.columns.map((column) => [column.name, column]));
		this.key = orderColumns(this.byName, key, `${name}: the key`);
		if (!this.key.length) throw new Error(`${name}: the key has no column`);
		const indexes = new Map<string, readonly string[]>();
		for (const [index, names] of Object.entries(declaredIndexes)) {
			if (!INDEX_NAME.test(index))
				throw new Error(`${name}: index "${index}": expected [a-z0-9_]+`);
			indexes.set(
				index,
				orderColumns(this.byName, names, `${name}: index "${index}"`),
			);
		}
		const hosts = this.columns.filter(
			(column): column is HostColumnOf => column.type === "str" && column.host !== undefined,
		);
		if (hosts.length > 1) throw new Error(`${name}: more than one host(...) column`);
		this.hostColumn = hosts[0];
		const hostIndex = this.hostColumn && this.key[0] !== this.hostColumn.name ? [this.hostColumn.name] : undefined;
		const declaredHost = indexes.get(HOST_INDEX);
		if (
			declaredHost !== undefined &&
			(hostIndex === undefined || declaredHost.length !== 1 || declaredHost[0] !== hostIndex[0])
		)
			throw new Error(`${name}: index "${HOST_INDEX}" is the host(...) column's own`);
		if (hostIndex) indexes.set(HOST_INDEX, hostIndex);
		this.indexes = indexes;
		this.record = Object.fromEntries(
			this.columns.map((column) => [column.name, columnRecord(column)]),
		);
		this.fingerprint = tableFingerprint(this.record, this.key, indexes);
		this.rows = new RowCodec(this.columns, this.key, name);
		this.refs = columnRefs(this.columns);
	}
	column(name: string, what: string): Column {
		const found = this.byName.get(name);
		if (!found) throw new Error(`${this.name}: ${what}: no column "${name}"`);
		return found;
	}
}
export function orderColumns(
	byName: ReadonlyMap<string, Column>,
	names: readonly string[],
	what: string,
): readonly string[] {
	if (!Array.isArray(names))
		throw new Error(`${what}: expected an array of column names`);
	if (new Set(names).size !== names.length)
		throw new Error(`${what}: a column occurs twice`);
	for (const name of names) {
		const column = byName.get(name);
		if (!column) throw new Error(`${what}: no column "${name}"`);
		if (column.optional || (column.type !== "str" && column.type !== "int"))
			throw new Error(
				`${what}: column "${name}" is not a non-opt str() or int() column`,
			);
	}
	return [...names];
}
export function tableFingerprint(
	columns: Readonly<Record<string, ColumnRecord>>,
	key: readonly string[],
	indexes: ReadonlyMap<string, readonly string[]>,
): string {
	const ordered = <T>(entries: Iterable<[string, T]>): Record<string, T> =>
		Object.fromEntries(
			[...entries].sort(([a], [b]) => (a === b ? 0 : a < b ? -1 : 1)),
		);
	return hash64(
		JSON.stringify({
			tableFormVersion: TABLE_FORM_VERSION,
			value: {
				columns: ordered(Object.entries(columns)),
				key,
				indexes: ordered(indexes),
			},
		}),
	);
}
