import type { TelemetryStore } from "@axi/telemetry";
import { openNodeSqliteDatabase } from "../sqlite/node.ts";
import { assertTelemetryStore } from "./schema.ts";
import { findMetrics, findTraces, getTrace } from "./store.ts";

export interface SqliteTelemetryStore extends TelemetryStore {
	close(): Promise<void>;
}

export async function openTelemetryStore(path: string): Promise<SqliteTelemetryStore> {
	const database = await openNodeSqliteDatabase(path, { mode: "read-only" });
	try {
		await assertTelemetryStore(database);
	} catch (error) {
		await database.close();
		throw error;
	}
	return {
		getTrace: (id) => getTrace(database, id),
		findTraces: (query) => findTraces(database, query),
		findMetrics: (query) => findMetrics(database, query),
		close: () => database.close(),
	};
}
