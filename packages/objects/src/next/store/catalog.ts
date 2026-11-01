import type { SqliteExecutor } from "../../sqlite/index.ts";
import type { ColumnRecord } from "./columns.ts";
import { TABLES } from "./schema.ts";

export type TableRecord = {
	readonly table: string;
	readonly version: number;
	readonly state: "ready" | "migrating";
	readonly columns: { readonly [name: string]: ColumnRecord };
	readonly key: readonly string[];
	readonly fingerprint: string;
	readonly indexes: { readonly [name: string]: readonly string[] };
};

export async function readCatalog(
	executor: SqliteExecutor,
): Promise<Map<string, TableRecord>> {
	const rows = await executor.all<{ name: string; definition: string }>(
		`SELECT name, definition FROM ${TABLES.tables}`,
	);
	return new Map(
		rows.map((row) => [row.name, JSON.parse(row.definition) as TableRecord]),
	);
}
export async function writeCatalog(
	step: Pick<SqliteExecutor, "run"> & {
		readonly tables: ReadonlyMap<string, TableRecord>;
	},
): Promise<void> {
	for (const [name, record] of step.tables)
		await step.run(
			`INSERT OR REPLACE INTO ${TABLES.tables} (name, definition) VALUES (?, ?)`,
			name,
			JSON.stringify(record),
		);
}
