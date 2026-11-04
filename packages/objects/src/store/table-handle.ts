import type { Context } from "../context/index.ts";
import type { SqliteValue } from "../sqlite/index.ts";
import { ObjectsError } from "../data/index.ts";
import { invalid } from "../data/internal.ts";
import type { Columns, RowOf } from "./columns.ts";
import { decodeCursor, encodeCursor, type Query } from "./query.ts";
import { TableSql } from "./sql.ts";
import type { ObjectsStore } from "./store.ts";
import type { KeyOf, TableDefinition } from "./table.ts";

export type Page<T> = { readonly items: T[]; readonly next?: string };
export type PageOptions = { readonly after?: string };
export interface Table<C extends Columns, K extends readonly string[]> {
	page(
		q: Query<C, K>,
		limit: number,
		context: Context,
		options?: PageOptions,
	): Promise<Page<RowOf<C>>>;
	rows(q: Query<C, K>, context: Context): AsyncIterable<RowOf<C>>;
	get(key: KeyOf<C, K>, context: Context): Promise<RowOf<C> | undefined>;
	count(q: Query<C, K>, context: Context): Promise<number>;
}
export type TableOf<D> = D extends TableDefinition<infer C, infer K>
	? Table<C, K>
	: never;
export type TableOwner = {
	readonly queries: import("./live-query.ts").LiveQueries;
	readonly label: string;
	readonly scope: object;
	assertLive(): void;
	fail(error: ObjectsError): void;
};
export const ROWS_PAGE = 100;
export class TableHandle implements Table<Columns, readonly string[]> {
	readonly definition: TableDefinition;
	readonly sql: TableSql;
	readonly store: ObjectsStore;
	readonly owner: TableOwner;
	constructor(
		definition: TableDefinition,
		sqlName: string,
		store: ObjectsStore,
		owner: TableOwner,
	) {
		this.definition = definition;
		this.store = store;
		this.owner = owner;
		this.sql = new TableSql(
			sqlName,
			definition.columns,
			definition.rows.physical,
			definition.key,
		);
	}
	#assertQuery(q: Query): void {
		if (q.table !== this.definition)
			throw invalid(
				"args",
				`${this.owner.label}: a query of table "${q.table.name}" run on "${this.definition.name}"`,
			);
	}
	decode(
		stored: Readonly<Record<string, SqliteValue>>,
		context: Context,
	): RowOf<Columns> {
		try {
			return this.definition.rows.decode(stored, context) as RowOf<Columns>;
		} catch (error) {
			const failure =
				error instanceof ObjectsError
					? error
					: new ObjectsError(
							{ code: "unavailable", message: String(error) },
							{ cause: error },
						);
			this.owner.fail(failure);
			throw failure;
		}
	}
	async get(
		key: unknown,
		context: Context,
	): Promise<RowOf<Columns> | undefined> {
		this.owner.assertLive();
		this.assertVersion();
		const encoded = this.definition.rows.key(key, "get");
		const row = await this.store.read(
			(executor) =>
				executor.get<Record<string, SqliteValue>>(
					this.sql.get,
					...encoded.params,
				),
			context,
		);
		return row === undefined ? undefined : this.decode(row, context);
	}
	async page(
		q: Query,
		limit: number,
		context: Context,
		options: PageOptions = {},
	): Promise<Page<RowOf<Columns>>> {
		this.owner.assertLive();
		this.assertVersion();
		this.#assertQuery(q);
		if (!Number.isSafeInteger(limit) || limit < 1)
			throw invalid(
				"args",
				`${this.definition.name}: limit is a positive integer`,
			);
		const order = q.order,
			after =
				options.after === undefined
					? undefined
					: decodeCursor(this.definition, this.sql.table, order, options.after);
		const statement = this.sql.select(q.condition, order, after, limit + 1);
		const rows = await this.store.read(
			(executor) =>
				executor.all<Record<string, SqliteValue>>(
					statement.sql,
					...statement.params,
				),
			context,
		);
		const more = rows.length > limit;
		if (more) rows.length = limit;
		const items = rows.map((row) => this.decode(row, context));
		return more
			? {
					items,
					next: encodeCursor(
						this.sql.table,
						order,
						order.columns.map((name) => rows.at(-1)![name]!),
					),
				}
			: { items };
	}
	async *rows(q: Query, context: Context): AsyncIterable<RowOf<Columns>> {
		let next: string | undefined;
		for (;;) {
			const page = await this.page(
				q,
				ROWS_PAGE,
				context,
				next === undefined ? {} : { after: next },
			);
			yield* page.items;
			if (page.next === undefined) return;
			next = page.next;
		}
	}
	async count(q: Query, context: Context): Promise<number> {
		this.owner.assertLive();
		this.assertVersion();
		this.#assertQuery(q);
		const statement = this.sql.count(q.condition);
		return (
			(
				await this.store.read(
					(executor) =>
						executor.get<{ count: number }>(statement.sql, ...statement.params),
					context,
				)
			)?.count ?? 0
		);
	}
	assertVersion(): void {
		const version = this.store.tableVersion(this.sql.table);
		if (version !== undefined && version > this.definition.version)
			throw new ObjectsError({
				code: "released",
				reason: "version",
				message: `${this.owner.label}: table "${this.definition.name}" of version ${this.definition.version}; the store has version ${version}`,
			});
	}
}
