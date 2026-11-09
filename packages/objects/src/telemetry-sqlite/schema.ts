import { applySqliteMigrations, type SqliteDatabase, type SqliteMigration } from "../sqlite/index.ts";

const migrations: readonly SqliteMigration[] = [
	{
		version: 1,
		statements: [
			"CREATE TABLE telemetry_spans (id TEXT PRIMARY KEY, trace_id TEXT NOT NULL, parent_id TEXT, name TEXT, started_ms REAL, ended_ms REAL NOT NULL, attributes TEXT, events TEXT, links TEXT, status TEXT)",
			"CREATE INDEX telemetry_spans_ended_ms ON telemetry_spans(ended_ms)",
			"CREATE INDEX telemetry_spans_trace_started ON telemetry_spans(trace_id, started_ms)",
			"CREATE INDEX telemetry_spans_started_ms ON telemetry_spans(started_ms)",
			"CREATE TABLE telemetry_metrics (interval_ms INTEGER, series_key TEXT, name TEXT, kind TEXT, unit TEXT, attributes TEXT, count INTEGER, sum REAL, min REAL, max REAL, PRIMARY KEY(interval_ms, series_key))",
		],
	},

	{
		version: 2,
		statements: [
			"CREATE TABLE telemetry_spans_us (id TEXT PRIMARY KEY, trace_id TEXT NOT NULL, parent_id TEXT, name TEXT, started_us INTEGER, ended_us INTEGER NOT NULL, attributes TEXT, events TEXT, links TEXT, status TEXT)",
			"INSERT INTO telemetry_spans_us SELECT id, trace_id, parent_id, name, CAST(round(started_ms * 1000) AS INTEGER), CAST(round(ended_ms * 1000) AS INTEGER), attributes, events, links, status FROM telemetry_spans",
			"DROP TABLE telemetry_spans",
			"ALTER TABLE telemetry_spans_us RENAME TO telemetry_spans",
			"CREATE INDEX telemetry_spans_ended_us ON telemetry_spans(ended_us)",
			"CREATE INDEX telemetry_spans_trace_started ON telemetry_spans(trace_id, started_us)",
			"CREATE INDEX telemetry_spans_started_us ON telemetry_spans(started_us)",
		],
	},
];

export function migrateTelemetryStore(db: SqliteDatabase): Promise<void> {
	return applySqliteMigrations(db, migrations, { table: "telemetry_schema" });
}
export async function assertTelemetryStore(db: SqliteDatabase): Promise<void> {
	const table = await db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", "telemetry_schema");
	if (!table) throw new Error("not a telemetry store: no telemetry_schema table");
	const version =
		(await db.get<{ version: number }>("SELECT version FROM telemetry_schema WHERE singleton = 1"))?.version ?? 0;
	if (version > 2) throw new Error(`telemetry store version ${version} is newer than this reader's 2`);
	if (version < 2)
		throw new Error(`telemetry store version ${version}, not 2: a recorder (createSqliteTelemetry) migrates it`);
}
