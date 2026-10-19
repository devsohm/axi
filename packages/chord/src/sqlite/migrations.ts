import type { SqliteDatabase } from "./database.ts";
import { validateSqliteSchemaPrefix } from "./schema.ts";

export type SqliteMigration = { readonly version: number; readonly statements: readonly string[] };

export async function applySqliteMigrations(
	database: SqliteDatabase,
	migrations: readonly SqliteMigration[],
	options: { readonly table: string },
): Promise<void> {
	const table = options.table;
	validateSqliteSchemaPrefix(table);
	for (let index = 0; index < migrations.length; index++) {
		if (migrations[index]?.version !== index + 1)
			throw new Error("SQLite migrations must have contiguous versions starting at 1");
	}
	await database.transaction(async (transaction) => {
		await transaction.exec(`CREATE TABLE IF NOT EXISTS ${table} (
			singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
			version INTEGER NOT NULL CHECK (version >= 0)
		) STRICT`);
		await transaction.run(`INSERT OR IGNORE INTO ${table} (singleton, version) VALUES (1, 0)`);
		const stored = await transaction.get<{ version: number }>(`SELECT version FROM ${table} WHERE singleton = 1`);
		if (stored === undefined) throw new Error("SQLite schema metadata is missing");
		const supported = migrations.at(-1)?.version ?? 0;
		if (stored.version > supported) {
			throw new Error(`SQLite schema version ${stored.version} is newer than supported version ${supported}`);
		}
		for (const migration of migrations) {
			if (migration.version <= stored.version) continue;
			for (const sql of migration.statements) await transaction.exec(sql);
			await transaction.run(`UPDATE ${table} SET version = ? WHERE singleton = 1`, migration.version);
		}
	});
}
