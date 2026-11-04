import type { Context } from "@axi/objects";
import type { Order, OwnerTable, WhereNode } from "@axi/objects/next";
import type { SqliteExecutor, SqliteValue } from "@axi/objects/sqlite";
import type { CommitTables } from "./commit.ts";

type RecordRow = {
	readonly record: string;
	readonly record$v?: number;
	readonly commit_seq?: number;
};
export type Condition = readonly [
	string,
	"eq" | "gt" | "lt" | "gte" | "lte",
	SqliteValue,
];
export class TableQueries {
	readonly #table: OwnerTable;
	readonly #read:
		| ((text: string, version: number, context: Context) => unknown)
		| undefined;
	readonly #columns: readonly string[];
	readonly #byId: string;
	readonly #compiled = new Map<string, string>();
	constructor(table: OwnerTable, byIdExtra: readonly string[] = []) {
		this.#table = table;
		this.#read =
			table.jsonVersion("record") > 1 ? table.reader("record") : undefined;
		this.#columns = this.#read ? ["record", "record$v"] : ["record"];
		this.#byId = table.prepareGet([...this.#columns, ...byIdExtra]);
	}
	byId(
		executor: Pick<SqliteExecutor, "get">,
		id: number,
	): Promise<RecordRow | undefined> {
		return executor.get<RecordRow>(this.#byId, id);
	}
	select(
		executor: Pick<SqliteExecutor, "all">,
		conditions: readonly Condition[],
		direction: "ascending" | "descending",
		limit: number,
	): Promise<RecordRow[]> {
		return executor.all<RecordRow>(
			this.#sql(conditions, direction, false),
			...conditions.map((condition) => condition[2]),
			limit,
		);
	}
	first(
		executor: Pick<SqliteExecutor, "get">,
		conditions: readonly Condition[],
		direction: "ascending" | "descending",
	): Promise<RecordRow | undefined> {
		return executor.get<RecordRow>(
			this.#sql(conditions, direction, true),
			...conditions.map((condition) => condition[2]),
		);
	}
	record<T>(row: RecordRow, context: Context): T {
		return (
			this.#read
				? this.#read(row.record, row.record$v!, context)
				: JSON.parse(row.record)
		) as T;
	}
	records<T>(rows: readonly RecordRow[], into: T[], context: Context): void {
		const read = this.#read;
		for (const row of rows)
			into.push(
				(read
					? read(row.record, row.record$v!, context)
					: JSON.parse(row.record)) as T,
			);
	}
	#sql(
		conditions: readonly Condition[],
		direction: "ascending" | "descending",
		first: boolean,
	): string {
		const key = `${first ? "first" : "many"} ${direction}${conditions.map(([name, op]) => ` ${name} ${op}`).join("")}`;
		const cached = this.#compiled.get(key);
		if (cached !== undefined) return cached;
		const nodes = conditions.map(([name, op]): WhereNode => {
			switch (op) {
				case "eq":
					return { eq: [name, 0] };
				case "gt":
					return { gt: [name, 0] };
				case "lt":
					return { lt: [name, 0] };
				case "gte":
					return { gte: [name, 0] };
				case "lte":
					return { lte: [name, 0] };
			}
		});
		const where: WhereNode | undefined = nodes.length
				? { and: nodes }
				: undefined,
			order: Order = {
				columns: ["id"],
				direction: direction === "ascending" ? "asc" : "desc",
			};
		const sql = first
			? this.#table.prepareFirst(this.#columns, where, order)
			: this.#table.prepare(this.#columns, where, order);
		this.#compiled.set(key, sql);
		return sql;
	}
}
export type StorageQueries = {
	readonly conversations: TableQueries;
	readonly entries: TableQueries;
	readonly latestHead: { readonly any: string; readonly atOrBefore: string };
	readonly tasks: TableQueries;
	readonly submissions: TableQueries;
};
export function storageQueries(tables: CommitTables): StorageQueries {
	const descending: Order = { columns: ["id"], direction: "desc" };
	return {
		conversations: new TableQueries(tables.conversations),
		entries: new TableQueries(tables.entries, ["commit_seq"]),
		tasks: new TableQueries(tables.tasks),
		submissions: new TableQueries(tables.submissions),
		latestHead: {
			any: tables.entryHeads.prepareFirst(
				["id"],
				{ eq: ["conversation_id", 0] },
				descending,
			),
			atOrBefore: tables.entryHeads.prepareFirst(
				["id"],
				{ and: [{ eq: ["conversation_id", 0] }, { lte: ["id", 0] }] },
				descending,
			),
		},
	};
}
