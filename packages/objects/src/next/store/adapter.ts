import type { Context } from "../../context/index.ts";
import type { SqliteExecutor, SqliteValue } from "../../sqlite/index.ts";
import { checkName } from "../contracts/names.ts";
import type { Claimant } from "./claims.ts";
import type { WhereNode } from "./expression.ts";
import type { EncodedRow } from "./rows.ts";
import { TableSql, tableSqlName, type Order } from "./sql.ts";
import type { Step } from "./step.ts";
import type { ObjectsStore } from "./store.ts";
import type { TableDefinition } from "./table.ts";
import { prepareTables } from "./table-migration.ts";
import type { TableWrite } from "./table-writes.ts";

export type DecodedRow = Readonly<Record<string, unknown>>;
export class StoreOwnerTables {
	readonly store: ObjectsStore;
	readonly owner: string;
	readonly #claimant: Claimant;
	readonly #declared: OwnerTable[] = [];
	constructor(store: ObjectsStore, owner: string, claimant: Claimant) {
		checkName(owner, "An owner name");
		this.store = store;
		this.owner = owner;
		this.#claimant = claimant;
	}
	declare(definition: TableDefinition): OwnerTable {
		const table = new OwnerTable(
			definition,
			tableSqlName(this.owner, definition.name),
		);
		this.store.claims.table(table.sql.table, this.#claimant);
		this.#declared.push(table);
		return table;
	}
	prepare(context: Context): Promise<void> {
		return prepareTables(
			this.#declared.map((handle) => ({
				definition: handle.definition,
				table: handle.sql.table,
			})),
			this.store,
			{ admit: () => true, adopt: () => {} },
			this.owner,
			context,
		);
	}
}
export class OwnerTable {
	readonly definition: TableDefinition;
	readonly sql: TableSql;
	constructor(definition: TableDefinition, table: string) {
		this.definition = definition;
		this.sql = new TableSql(
			table,
			definition.columns,
			definition.rows.physical,
			definition.key,
		);
	}
	encode(row: unknown): EncodedRow {
		return this.definition.rows.put(row, this.definition.version);
	}
	async put(
		step: Step,
		encoded: EncodedRow,
		stamp?: string,
	): Promise<TableWrite> {
		const params = [...encoded.params];
		if (stamp !== undefined)
			params[this.definition.rows.physical.indexOf(stamp)] = step.seq;
		await step.run(this.sql.put, ...params);
		return {
			kind: "put",
			table: this.sql.table,
			row:
				stamp === undefined
					? encoded.row
					: { ...encoded.row, [stamp]: step.seq },
			version: this.definition.version,
			columns: encoded.columns,
		};
	}
	async get(
		executor: Pick<SqliteExecutor, "get">,
		params: readonly SqliteValue[],
		context: Context,
	): Promise<DecodedRow | undefined> {
		const row = await executor.get<Record<string, SqliteValue>>(
			this.sql.get,
			...params,
		);
		return row === undefined
			? undefined
			: this.definition.rows.decode(row, context);
	}
	prepare(
		columns: readonly string[],
		where: WhereNode | undefined,
		order: Order,
	): string {
		return this.sql.select(where, order, undefined, 0, columns).sql;
	}
	prepareFirst(
		columns: readonly string[],
		where: WhereNode | undefined,
		order: Order,
	): string {
		return this.sql
			.select(where, order, undefined, 1, columns)
			.sql.replace(/LIMIT \?$/, "LIMIT 1");
	}
	prepareGet(columns: readonly string[]): string {
		return this.sql.getColumns(columns);
	}
	jsonVersion(name: string): number {
		const column = this.definition.column(name, "jsonVersion");
		if (column.type !== "json")
			throw new Error(
				`${this.definition.name}: column "${name}" is no json(...) column`,
			);
		return column.json.version;
	}
	reader(
		name: string,
	): (text: string, version: number, context: Context) => unknown {
		const column = this.definition.column(name, "reader");
		if (column.type !== "json")
			throw new Error(
				`${this.definition.name}: column "${name}" is no json(...) column`,
			);
		return column.json.version === 1
			? (text) => JSON.parse(text) as unknown
			: (text, version, context) =>
					column.json.read(text, version, `${this.sql.table}.${name}`, context);
	}
	async select(
		executor: Pick<SqliteExecutor, "all">,
		where: WhereNode | undefined,
		order: Order,
		limit: number,
		context: Context,
	): Promise<DecodedRow[]> {
		const statement = this.sql.select(where, order, undefined, limit);
		return (
			await executor.all<Record<string, SqliteValue>>(
				statement.sql,
				...statement.params,
			)
		).map((row) => this.definition.rows.decode(row, context));
	}
}
