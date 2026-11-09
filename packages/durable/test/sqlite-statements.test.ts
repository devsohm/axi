import { describe, expect, it } from "vitest";
import { SQLITE_MIGRATIONS } from "../src/storage/sqlite/index.ts";
import { createSqliteMigrations } from "../src/storage/sqlite/migrations.ts";
import { createSqliteSchema } from "../src/storage/sqlite/schema.ts";

describe("SQLite migration statements", () => {
	it("emits the metadata initialization immediately after its table", () => {
		expect(SQLITE_MIGRATIONS[0]?.statements.slice(0, 2)).toEqual([
			"CREATE TABLE durable_metadata (\n\t\t\tsingleton INTEGER PRIMARY KEY CHECK (singleton = 1),\n\t\t\tnext_id TEXT NOT NULL,\n\t\t\tnext_seq INTEGER NOT NULL\n\t\t) STRICT",
			"INSERT INTO durable_metadata (singleton, next_id, next_seq) VALUES (1, '2', 1)",
		]);
	});
	it("places each table's indexes before creating the next table", () => {
		const statements = createSqliteMigrations(createSqliteSchema("app_"))[0]?.statements;
		expect(statements?.slice(4, 6)).toEqual([
			"CREATE INDEX app_conversations_by_owner_conversation ON app_conversations (owner_conversation_id, id)",
			"CREATE INDEX app_conversations_by_owner_task ON app_conversations (owner_task_id, id)",
		]);
	});
});
