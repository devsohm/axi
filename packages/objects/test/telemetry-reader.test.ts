import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { openNodeSqliteDatabase } from "../src/sqlite/node.ts";
import { createSqliteTelemetry } from "../src/telemetry-sqlite/index.ts";
import { openTelemetryStore } from "../src/telemetry-sqlite/node.ts";

test("the read-only telemetry store opens independently after recording and returns persisted traces and metrics", async () => {
	const directory = await mkdtemp(join(tmpdir(), "axi-telemetry-reader-")),
		path = join(directory, "traces.sqlite");
	const database = await openNodeSqliteDatabase(path),
		recorder = await createSqliteTelemetry(database);
	try {
		await recorder.startSpan({ name: "saved request" }, (root) => root.setAttributes({ method: "read" }));
		recorder.metrics.counter("calls").add(3);
		await recorder.close();
		await database.close();
		const reader = await openTelemetryStore(path);
		try {
			const traces = await reader.findTraces({ name: "saved request" });
			expect(traces.traces).toHaveLength(1);
			expect(await reader.getTrace(traces.traces[0]!.traceId)).toEqual(traces.traces[0]);
			expect(await reader.getTrace("absent")).toBeUndefined();
			expect(await reader.findMetrics({ name: "calls" })).toMatchObject([{ sum: 3 }]);
		} finally {
			await reader.close();
		}
		await expect(openTelemetryStore(join(directory, "absent.sqlite"))).rejects.toThrow();
	} finally {
		await recorder.close();
		await database.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("the telemetry reader rejects an unrelated database without retaining its file", async () => {
	const directory = await mkdtemp(join(tmpdir(), "axi-telemetry-schema-")),
		path = join(directory, "other.sqlite");
	const database = await openNodeSqliteDatabase(path);
	try {
		await database.exec("CREATE TABLE unrelated (id INTEGER)");
		await database.close();
		await expect(openTelemetryStore(path)).rejects.toThrow();
	} finally {
		await database.close();
		await rm(directory, { recursive: true, force: true });
	}
});
