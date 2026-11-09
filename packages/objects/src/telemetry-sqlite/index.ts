import type { TelemetryContext, TelemetryMetrics, TelemetryPropagation, TelemetryStore } from "@axi/telemetry";
import type { SqliteDatabase } from "../sqlite/index.ts";
import { TelemetryRecorder, seriesKey, sortedAttributes, type TelemetryBatch } from "../telemetry-ingest/recorder.ts";
import { migrateTelemetryStore } from "./schema.ts";
import { getTrace, findTraces, findMetrics } from "./store.ts";

export type { TelemetryBatch } from "../telemetry-ingest/recorder.ts";
export interface SqliteTelemetryOptions {
	readonly retentionMs?: number;
	readonly maxQueuedSpans?: number;
}
export interface SqliteTelemetry extends TelemetryContext, TelemetryStore {
	readonly metrics: TelemetryMetrics;
	readonly propagation: TelemetryPropagation;
	readonly droppedSpans: number;
	readonly droppedMeasurements: number;
	ingest(batch: TelemetryBatch): number;
	flush(): Promise<void>;
	close(): Promise<void>;
}

class SqliteRecorder implements SqliteTelemetry {
	readonly #recorder: TelemetryRecorder;
	readonly #db: SqliteDatabase;
	readonly #retention: number;
	readonly #timer: ReturnType<typeof setInterval>;
	#failure: { error: unknown } | undefined;
	#writing?: Promise<void>;
	#closing?: Promise<void>;
	constructor(db: SqliteDatabase, retention: number, capacity: number) {
		this.#db = db;
		this.#retention = retention;
		const scope = crypto.randomUUID();
		this.#recorder = new TelemetryRecorder(() => scope, capacity);
		this.#timer = setInterval(() => {
			if (!this.#writing) void this.flush().catch(() => {});
		}, 1000);
		this.#timer.unref?.();
	}
	get metrics(): TelemetryMetrics {
		return this.#recorder.metrics;
	}
	get propagation(): TelemetryPropagation {
		return this.#recorder;
	}
	get droppedSpans(): number {
		return this.#recorder.droppedSpans;
	}
	get droppedMeasurements(): number {
		return this.#recorder.droppedMeasurements;
	}
	readonly startSpan: TelemetryContext["startSpan"] = (options, callback) =>
		this.#recorder.startSpan(options, callback);
	readonly getTrace: TelemetryStore["getTrace"] = (id) => getTrace(this.#db, id);
	readonly findTraces: TelemetryStore["findTraces"] = (query) => findTraces(this.#db, query);
	readonly findMetrics: TelemetryStore["findMetrics"] = (query) => findMetrics(this.#db, query);
	ingest(batch: TelemetryBatch): number {
		return this.#recorder.ingest(batch);
	}
	flush(): Promise<void> {
		return this.#closing ?? this.drain(false);
	}
	close(): Promise<void> {
		if (!this.#closing) {
			this.#recorder.stop("keep");
			clearInterval(this.#timer);
			this.#closing = this.drain(true);
		}
		return this.#closing;
	}
	private async drain(partial: boolean): Promise<void> {
		while (this.#writing) await this.#writing;
		if (this.#failure) throw this.#failure.error;
		const batch = this.#recorder.take(partial);
		this.#writing = Promise.resolve()
			.then(() =>
				this.#db.transaction(async (tx) => {
					for (const span of batch.spans)
						await tx.run(
							"INSERT OR IGNORE INTO telemetry_spans VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
							span.id,
							span.traceId,
							span.parentId ?? null,
							span.name,
							Math.round(span.startedMs * 1000),
							Math.round(span.endedMs * 1000),
							JSON.stringify(span.attributes),
							JSON.stringify(
								span.events.map(({ name, timeMs, attributes }) => ({ name, time_ms: timeMs, attributes })),
							),
							JSON.stringify(
								span.links.map(({ traceId, spanId, attributes }) => ({
									trace_id: traceId,
									span_id: spanId,
									attributes,
								})),
							),
							JSON.stringify(span.status),
						);
					for (const metric of batch.metrics)
						await tx.run(
							`INSERT INTO telemetry_metrics VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(interval_ms, series_key) DO UPDATE SET count = count + excluded.count, sum = sum + excluded.sum,
				min = min(min, excluded.min), max = max(max, excluded.max)`,
							metric.intervalMs,
							seriesKey(metric),
							metric.name,
							metric.kind,
							metric.unit ?? null,
							JSON.stringify(sortedAttributes(metric.attributes)),
							metric.count,
							metric.sum,
							metric.min,
							metric.max,
						);
					const cutoff = Date.now() - this.#retention;
					await tx.run("DELETE FROM telemetry_spans WHERE ended_us < ?", cutoff * 1000);
					await tx.run("DELETE FROM telemetry_metrics WHERE interval_ms < ?", cutoff);
				}),
			)
			.catch((error: unknown) => {
				this.#failure = { error };
				this.#recorder.stop("discard");
				clearInterval(this.#timer);
				throw error;
			})
			.finally(() => {
				this.#writing = undefined;
				this.#recorder.release();
			});
		await this.#writing;
	}
}

export async function createSqliteTelemetry(
	db: SqliteDatabase,
	options: SqliteTelemetryOptions = {},
): Promise<SqliteTelemetry> {
	const retention = options.retentionMs ?? 604800000;
	const capacity = options.maxQueuedSpans ?? 10000;
	await migrateTelemetryStore(db);
	return new SqliteRecorder(db, retention, capacity);
}
