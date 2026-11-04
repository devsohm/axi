import type { SqliteDatabase } from "../../sqlite/index.ts";

export class Backend {
	readonly db: SqliteDatabase;
	constructor(db: SqliteDatabase) {
		this.db = db;
	}
}
export function sqliteBackend(db: SqliteDatabase): Backend {
	return new Backend(db);
}
