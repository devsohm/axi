import { expect, test } from "vitest";
import { openNodeSqliteDatabase } from "../src/sqlite/node.ts";
import { createSqliteTelemetry } from "../src/telemetry-sqlite/index.ts";

test("telemetry upgrades existing timestamps and preserves the first ingested span with a given ID", async () => {
	const db = await openNodeSqliteDatabase(":memory:");
	await db.exec(`CREATE TABLE telemetry_schema(singleton INTEGER PRIMARY KEY, version INTEGER);
		INSERT INTO telemetry_schema VALUES(1, 1);
		CREATE TABLE telemetry_spans(id TEXT PRIMARY KEY, trace_id TEXT, parent_id TEXT, name TEXT, started_ms REAL,
		ended_ms REAL, attributes TEXT, events TEXT, links TEXT, status TEXT);
		CREATE TABLE telemetry_metrics(interval_ms INTEGER, series_key TEXT, name TEXT, kind TEXT, unit TEXT,
		attributes TEXT, count INTEGER, sum REAL, min REAL, max REAL, PRIMARY KEY(interval_ms, series_key));`);
	const now = Date.now();
	await db.run("INSERT INTO telemetry_spans VALUES(?, ?, NULL, ?, ?, ?, '{}', '[]', '[]', ?)", "first", "trace", "original", now + 0.125, now + 0.5, '{"status":"ok"}');
	const recorder = await createSqliteTelemetry(db);
	try {
		const trace = await recorder.getTrace("trace");
		expect(trace!.spans[0]!.startedMs).toBe(now + 0.125);
		expect(await db.get("SELECT version FROM telemetry_schema")).toEqual({ version: 2 });
		expect(await db.get("SELECT typeof(started_us) AS storage FROM telemetry_spans")).toEqual({ storage: "integer" });
		expect(recorder.ingest({ spans: [{ ...trace!.spans[0]!, name: "replacement" }], metrics: [] })).toBe(1);
		await recorder.flush();
		expect((await recorder.getTrace("trace"))!.spans[0]!.name).toBe("original");
	} finally { await recorder.close(); await db.close(); }
});
