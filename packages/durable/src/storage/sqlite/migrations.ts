import { applySqliteMigrations as apply, type SqliteDatabase, type SqliteMigration } from "@axi/chord/sqlite";
import { DEFAULT_SQLITE_SCHEMA, type SqliteSchema } from "./schema.ts";
export type { SqliteMigration } from "@axi/chord/sqlite";
export function createSqliteMigrations(schema: SqliteSchema): readonly SqliteMigration[] {
	const { tables: t, indexes: i } = schema;
	const taskColumns = (sleeping: boolean): readonly string[] => [
		"id INTEGER PRIMARY KEY",
		"conversation_id INTEGER NOT NULL",
		"kind TEXT NOT NULL",
		`status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'waiting', ${sleeping ? "'sleeping', " : ""}'completing', 'terminal'))`,
		"abort_requested INTEGER NOT NULL CHECK (abort_requested IN (0, 1))",
		"background INTEGER NOT NULL CHECK (background IN (0, 1))",
		"record TEXT NOT NULL CHECK (json_valid(record))",
	];
	const definitions: readonly [string, readonly string[]][] = [
		[
			t.durableMetadata,
			["singleton INTEGER PRIMARY KEY CHECK (singleton = 1)", "next_id TEXT NOT NULL", "next_seq INTEGER NOT NULL"],
		],
		[
			t.recordIds,
			[
				"id INTEGER PRIMARY KEY",
				"record_type TEXT NOT NULL CHECK (record_type IN ('conversation', 'entry', 'task', 'submission', 'document'))",
			],
		],
		[
			t.conversations,
			[
				"id INTEGER PRIMARY KEY",
				"owner_conversation_id INTEGER",
				"owner_task_id INTEGER",
				"record TEXT NOT NULL CHECK (json_valid(record))",
			],
		],
		[
			t.entries,
			[
				"id INTEGER PRIMARY KEY",
				"conversation_id INTEGER NOT NULL",
				"head INTEGER",
				"commit_seq INTEGER NOT NULL",
				"record TEXT NOT NULL CHECK (json_valid(record))",
			],
		],
		[t.tasks, taskColumns(false)],
		[
			t.submissions,
			[
				"id INTEGER PRIMARY KEY",
				"conversation_id INTEGER NOT NULL",
				"request_id TEXT",
				"status TEXT NOT NULL CHECK (status IN ('queued', 'placed', 'done', 'unanswered'))",
				"record TEXT NOT NULL CHECK (json_valid(record))",
			],
		],
		[
			t.documents,
			[
				"id INTEGER PRIMARY KEY",
				"kind TEXT NOT NULL",
				"family INTEGER NOT NULL CHECK (family IN (0, 1))",
				"key_value TEXT NOT NULL",
				"scope_kind TEXT NOT NULL CHECK (scope_kind IN ('session', 'conversation', 'task'))",
				"owner_id INTEGER NOT NULL",
				"created_at INTEGER NOT NULL",
				"retired_at INTEGER",
				"record TEXT NOT NULL CHECK (json_valid(record))",
			],
		],
		[
			t.documentRevisions,
			[
				"document_id INTEGER NOT NULL",
				"seq INTEGER NOT NULL",
				"kind TEXT NOT NULL CHECK (kind IN ('base', 'delta'))",
				"version INTEGER NOT NULL",
				"content TEXT NOT NULL CHECK (json_valid(content))",
				"PRIMARY KEY (document_id, seq)",
			],
		],
	];
	const indexes: readonly [string, string, string, string?][] = [
		[i.conversationsByOwnerConversation, t.conversations, "owner_conversation_id,id"],
		[i.conversationsByOwnerTask, t.conversations, "owner_task_id,id"],
		[i.entriesByConversation, t.entries, "conversation_id,id DESC"],
		[i.entryHeadsByConversation, t.entries, "conversation_id,id DESC", "head IS NOT NULL"],
		[i.tasksByStatus, t.tasks, "status,id"],
		[i.tasksByConversation, t.tasks, "conversation_id,id"],
		[i.tasksByKind, t.tasks, "kind,id"],
		[i.tasksByAbortRequested, t.tasks, "abort_requested,id"],
		[i.tasksByBackground, t.tasks, "background,id"],
		[i.submissionsByRequest, t.submissions, "conversation_id,request_id"],
		[i.submissionsByConversation, t.submissions, "conversation_id,id"],
		[i.submissionsByStatus, t.submissions, "status,id"],
		[i.documentsByAddress, t.documents, "kind,scope_kind,owner_id,family,key_value,created_at DESC,retired_at"],
		[i.documentsByScope, t.documents, "scope_kind,owner_id,id"],
		[i.documentsByScopeKind, t.documents, "scope_kind,owner_id,kind,id"],
		[i.documentRevisionsByKind, t.documentRevisions, "document_id,kind,seq DESC"],
	];
	const createTable = (name: string, columns: readonly string[]): string =>
		`CREATE TABLE ${name} (\n\t\t\t${columns.join(",\n\t\t\t")}\n\t\t) STRICT`;
	const createIndex = ([name, table, columns, condition]: (typeof indexes)[number]): string =>
		`CREATE INDEX ${name}${name === i.documentsByAddress ? "\n\t\t\t" : " "}ON ${table} (${columns.replaceAll(",", ", ")})${condition ? ` WHERE ${condition}` : ""}`;
	const statements: string[] = [];
	for (const [name, columns] of definitions) {
		statements.push(createTable(name, columns));
		if (name === t.durableMetadata)
			statements.push(`INSERT INTO ${name} (singleton, next_id, next_seq) VALUES (1, '2', 1)`);
		statements.push(...indexes.filter(([, table]) => table === name).map(createIndex));
	}
	const replacement = `${t.tasks}_v2`;
	const sleeping = [
		createTable(replacement, taskColumns(true)),
		`INSERT INTO ${replacement} (id, conversation_id, kind, status, abort_requested, background, record)\n\t\t\tSELECT id, conversation_id, kind, status, abort_requested, background, record FROM ${t.tasks}`,
		`DROP TABLE ${t.tasks}`,
		`ALTER TABLE ${replacement} RENAME TO ${t.tasks}`,
		...indexes.filter(([, table]) => table === t.tasks).map(createIndex),
	];
	return [
		{ version: 1, statements },
		{ version: 2, statements: sleeping },
	];
}
export const SQLITE_MIGRATIONS = createSqliteMigrations(DEFAULT_SQLITE_SCHEMA);
export const CURRENT_SQLITE_SCHEMA_VERSION = SQLITE_MIGRATIONS.at(-1)?.version ?? 0;
export function applySqliteMigrationsForSchema(
	database: SqliteDatabase,
	schema: SqliteSchema,
	migrations: readonly SqliteMigration[] = createSqliteMigrations(schema),
): Promise<void> {
	return apply(database, migrations, { table: schema.tables.durableSchema });
}
export function applySqliteMigrations(
	database: SqliteDatabase,
	migrations: readonly SqliteMigration[] = SQLITE_MIGRATIONS,
): Promise<void> {
	return applySqliteMigrationsForSchema(database, DEFAULT_SQLITE_SCHEMA, migrations);
}
