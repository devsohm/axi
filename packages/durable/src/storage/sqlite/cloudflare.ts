import { DurableObjectSqliteDatabase, type DurableObjectSqliteStorage } from "@axi/chord/sqlite/cloudflare";
import { SqliteStorage, type SqliteStorageOptions } from "./storage.ts";
export { DurableObjectSqliteDatabase, type DurableObjectSqliteStorage } from "@axi/chord/sqlite/cloudflare";
export function openDurableObjectSqliteStorage(
	storage: DurableObjectSqliteStorage,
	options: SqliteStorageOptions = {},
): Promise<SqliteStorage> {
	return SqliteStorage.open(new DurableObjectSqliteDatabase(storage), options);
}
