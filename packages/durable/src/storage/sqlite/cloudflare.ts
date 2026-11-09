import { DurableObjectSqliteDatabase, type DurableObjectSqliteStorage } from "@axi/objects/sqlite/cloudflare";
import { SqliteStorage, type SqliteStorageOptions } from "./storage.ts";
export { DurableObjectSqliteDatabase, type DurableObjectSqliteStorage } from "@axi/objects/sqlite/cloudflare";
export function openDurableObjectSqliteStorage(
	storage: DurableObjectSqliteStorage,
	options: SqliteStorageOptions = {},
): Promise<SqliteStorage> {
	return SqliteStorage.open(new DurableObjectSqliteDatabase(storage), options);
}
