import { validateSqliteSchemaPrefix } from "@axi/chord/sqlite";
import { openNodeSqliteDatabase, type NodeSqliteDatabaseOptions } from "@axi/chord/sqlite/node";
import { SqliteStorage, type SqliteStorageOptions } from "./storage.ts";
export { NodeSqliteDatabase, openNodeSqliteDatabase, type NodeSqliteDatabaseOptions } from "@axi/chord/sqlite/node";
export type NodeSqliteStorageOptions = NodeSqliteDatabaseOptions & SqliteStorageOptions;
export async function openNodeSqliteStorage(
	path: string,
	options: NodeSqliteStorageOptions = {},
): Promise<SqliteStorage> {
	const { prefix, ...connectionOptions } = options;
	if (prefix !== undefined) validateSqliteSchemaPrefix(prefix);
	return SqliteStorage.open(await openNodeSqliteDatabase(path, connectionOptions), { prefix });
}
