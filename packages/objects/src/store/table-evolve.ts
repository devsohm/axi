import type { TOptional } from "typebox";
import { opt, type TSchema } from "../contracts/index.ts";
import { editWith } from "../contracts/evolve.ts";
import type { Increment } from "../contracts/history.ts";
import {
	checkColumnName,
	columnRecord,
	describeColumns,
	type ColumnSchema,
	type Columns,
	type ColumnTypeOf,
	type OrderColumn,
	type RowOf,
	type ValueOf,
} from "./columns.ts";
import {
	compileSet,
	compileWhere,
	type Condition,
	type SetOf,
} from "./expression.ts";
import type { ColumnRefs } from "./query.ts";
import {
	INDEX_NAME,
	orderColumns,
	TableDefinition,
	type TableOptions,
} from "./table.ts";
import type { DataStep, TableEdit } from "./table-history.ts";

type Without<C, N> = { readonly [P in Exclude<keyof C, N>]: C[P] };
type Added<C, N extends string, S> = {
	readonly [P in keyof C | N]: P extends N ? S : C[P & keyof C];
};
type Renamed<C, F, T extends string> = {
	readonly [P in keyof C as P extends F ? T : P]: C[P];
};
type RenamedKey<K extends readonly string[], F, T extends string> = {
	readonly [P in keyof K]: K[P] extends F ? T : K[P];
};
type JsonNames<C extends Columns> = {
	[P in keyof C]: ColumnTypeOf<C[P]> extends "json" ? P : never;
}[keyof C] &
	string;
type Next<V extends number> = number extends V
	? number
	: Increment<`${V}`> extends `${infer N extends number}`
		? N
		: number;
export type AddedColumn = ColumnSchema &
	(TOptional<TSchema> | { readonly default: unknown });
export type PatchOf<C extends Columns, K extends readonly string[]> = {
	readonly [P in Exclude<keyof C & string, K[number]>]?: ValueOf<C[P]>;
};
export interface TableTailEditor<
	C extends Columns,
	K extends readonly string[],
> {
	readonly "~columns"?: C;
	readonly "~key"?: K;
	drop<N extends Exclude<keyof C & string, K[number]>>(
		name: N,
	): TableTailEditor<Without<C, N>, K>;
	index(
		name: string,
		columns: readonly OrderColumn<C>[],
	): TableTailEditor<C, K>;
	dropIndex(name: string): TableTailEditor<C, K>;
}
export interface TableEditor<C extends Columns, K extends readonly string[]>
	extends TableTailEditor<C, K> {
	rename<F extends keyof C & string, T extends string>(
		from: F,
		to: T,
	): TableEditor<Renamed<C, F, T>, RenamedKey<K, F, T>>;
	add<N extends string, S extends AddedColumn>(
		name: N,
		column: S,
	): TableEditor<Added<C, N, S>, K>;
	json<N extends JsonNames<C>, S extends ColumnSchema>(
		name: N,
		column: S,
	): TableEditor<
		Added<C, N, C[N] extends TOptional<TSchema> ? TOptional<S> : S>,
		K
	>;
	rows(patch: (row: RowOf<C>) => PatchOf<C, K>): TableTailEditor<C, K>;
	update(step: {
		readonly where?: (row: ColumnRefs<C>) => Condition;
		readonly set: SetOf<C, K> | ((row: ColumnRefs<C>) => SetOf<C, K>);
	}): TableTailEditor<C, K>;
}
export function evolveTable<
	C extends Columns,
	K extends readonly string[],
	V extends number,
	E extends {
		readonly "~columns"?: Columns;
		readonly "~key"?: readonly string[];
	},
>(
	previous: TableDefinition<C, K, V>,
	edit: (table: TableEditor<C, K>) => E,
): TableDefinition<
	NonNullable<E["~columns"]>,
	NonNullable<E["~key"]>,
	Next<V>
> {
	const label = `${previous.name} version ${previous.version + 1}`;
	let schemas = { ...previous.schemas },
		keys = [...previous.key],
		tail = false;
	const indexes = new Map(previous.indexes),
		before: TableEdit[] = [],
		after: TableEdit[] = [];
	let data: DataStep | undefined;
	const refuse = (operation: string, message: string): never => {
		throw new Error(`${label}: ${operation}: ${message}`);
	};
	const requireHead = (operation: string): void => {
		if (tail)
			throw new Error(
				`${label}: ${operation} comes before the data step and before drop, index and dropIndex`,
			);
	};
	const existing = (name: string, operation: string): ColumnSchema => {
		if (!Object.hasOwn(schemas, name))
			return refuse(operation, `no column "${name}"`);
		return schemas[name]!;
	};
	const vacant = (name: string, operation: string, from?: string): void => {
		const fold = (value: string): string =>
			value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
		for (const present of Object.keys(schemas))
			if (present !== from && fold(present) === fold(name))
				refuse(
					operation,
					`column "${present}" exists (names differing only in case collide)`,
				);
	};
	const options = (): TableOptions<Columns, readonly never[]> =>
		({
			version: previous.version + 1,
			columns: { ...schemas },
			key: [...keys],
			indexes: Object.fromEntries(indexes),
		}) as unknown as TableOptions<Columns, readonly never[]>;
	const current = (): TableDefinition =>
		new TableDefinition(previous.name, options());
	const editor = {
		rename(from: string, to: string) {
			requireHead("rename");
			existing(from, "rename");
			checkColumnName(to, `${label}: rename`);
			vacant(to, "rename", from);
			const renamed = (name: string): string => (name === from ? to : name);
			schemas = Object.fromEntries(
				Object.entries(schemas).map(([name, value]) => [renamed(name), value]),
			);
			keys = keys.map(renamed);
			for (const [name, columns] of indexes)
				indexes.set(name, columns.map(renamed));
			before.push({ kind: "rename", from, to });
			return editor;
		},
		add(name: string, column: ColumnSchema) {
			requireHead("add");
			vacant(name, "add");
			const described = describeColumns(
				{ [name]: column },
				`${label}: add`,
			)[0]!;
			if (
				!described.optional &&
				(described.type === "json" || described.default === undefined)
			)
				refuse(
					"add",
					`column "${name}" needs opt(...) or a default (existing rows get it)`,
				);
			schemas[name] = column;
			before.push({ kind: "add", name, column: columnRecord(described) });
			return editor;
		},
		json(name: string, column: ColumnSchema) {
			requireHead("json");
			const old = describeColumns(
				{ [name]: existing(name, "json") },
				label,
			)[0]!;
			if (old.type !== "json")
				return refuse("json", `column "${name}" is not a json(...) column`);
			if (Object.hasOwn(column, "~optional"))
				return refuse(
					"json",
					"pass json(...) itself; the column keeps its nullability",
				);
			const schema = old.optional ? opt(column) : column,
				changed = describeColumns({ [name]: schema }, `${label}: json`)[0]!;
			if (changed.type !== "json")
				return refuse("json", "expected a json(...) column");
			if (changed.json.version < old.json.version)
				refuse(
					"json",
					`column "${name}" goes back from version ${old.json.version}`,
				);
			if (
				changed.json.version === old.json.version &&
				changed.json.fingerprint !== old.json.fingerprint
			)
				refuse(
					"json",
					`column "${name}" changes its schema at version ${old.json.version} (raise its version)`,
				);
			schemas[name] = schema;
			before.push({ kind: "json", name, column: columnRecord(changed) });
			return editor;
		},
		rows(patch: (row: Readonly<Record<string, unknown>>) => unknown) {
			requireHead("rows");
			if (typeof patch !== "function") refuse("rows", "expected a function");
			data = { kind: "rows", table: current(), patch };
			tail = true;
			return editor;
		},
		update(step: { readonly where?: unknown; readonly set: unknown }) {
			requireHead("update");
			const table = current(),
				at = `version ${table.version} update`;
			const condition: unknown =
				typeof step.where === "function" ? step.where(table.refs) : step.where;
			const values: unknown =
				typeof step.set === "function" ? step.set(table.refs) : step.set;
			data = {
				kind: "update",
				table,
				where:
					condition === undefined
						? undefined
						: compileWhere(table, condition, at),
				set: compileSet(table, values, at),
			};
			tail = true;
			return editor;
		},
		drop(name: string) {
			tail = true;
			existing(name, "drop");
			if (keys.includes(name)) refuse("drop", `"${name}" is a key column`);
			for (const [index, columns] of indexes)
				if (columns.includes(name)) {
					indexes.delete(index);
					after.push({ kind: "dropIndex", name: index });
				}
			delete schemas[name];
			after.push({ kind: "drop", name });
			return editor;
		},
		index(name: string, columns: readonly string[]) {
			tail = true;
			if (!INDEX_NAME.test(name))
				throw new Error(`${label}: index "${name}": expected [a-z0-9_]+`);
			if (indexes.has(name))
				throw new Error(`${label}: index "${name}" exists`);
			const checked = orderColumns(
				current().byName,
				columns,
				`${label}: index "${name}"`,
			);
			indexes.set(name, checked);
			after.push({ kind: "index", name, columns: checked });
			return editor;
		},
		dropIndex(name: string) {
			tail = true;
			if (!indexes.delete(name)) refuse("dropIndex", `no index "${name}"`);
			after.push({ kind: "dropIndex", name });
			return editor;
		},
	};
	editWith(
		editor as unknown as TableEditor<C, K>,
		edit,
		`${previous.name}: evolveTable`,
	);
	return new TableDefinition(previous.name, options(), {
		previous,
		migration: { before, step: data, after },
	}) as unknown as TableDefinition<
		NonNullable<E["~columns"]>,
		NonNullable<E["~key"]>,
		Next<V>
	>;
}
