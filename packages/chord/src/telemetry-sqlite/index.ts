import {
	NOOP_TELEMETRY_CONTEXT,
	type SpanAttributes,
	type SpanLink,
	type SpanOptions,
	type SpanStatus,
	type TelemetryCarrier,
	type TelemetryContext,
	type TelemetrySpan,
	type TelemetryStore,
	type TelemetryMetrics,
	type TelemetryPropagation,
	type InstrumentOptions,
} from "@axi/telemetry";
import { applySqliteMigrations, type SqliteDatabase, type SqliteValue } from "../sqlite/index.ts";
import { getTrace, findTraces, findMetrics } from "./store.ts";

export interface SqliteTelemetryOptions {
	readonly retentionMs?: number;
	readonly maxQueuedSpans?: number;
}
export interface SqliteTelemetry extends TelemetryContext, TelemetryStore {
	readonly metrics: TelemetryMetrics;
	readonly propagation: TelemetryPropagation;
	readonly droppedSpans: number;
	readonly droppedMeasurements: number;
	flush(): Promise<void>;
	close(): Promise<void>;
}
type Identity = { id: string; traceId: string };
type Metric = {
	interval: number;
	key: string;
	name: string;
	kind: "counter" | "upDownCounter" | "histogram";
	unit: string | null;
	attributes: string;
	count: number;
	sum: number;
	min: number;
	max: number;
};
const identities = new WeakMap<TelemetryContext, Identity>();
const spanKey = "axi-sqlite-span",
	traceKey = "axi-sqlite-trace";
const intervalStart = () => Math.floor(Date.now() / 10000) * 10000;
function attributes(value: SpanAttributes = {}): SpanAttributes {
	return Object.fromEntries(
		Object.entries(value)
			.filter(([, v]) => v !== undefined)
			.map(([key, v]) => [key, Array.isArray(v) ? [...v] : v]),
	);
}
function link(value: SpanLink) {
	const identity = identities.get(value.context);
	return identity
		? { trace_id: identity.traceId, span_id: identity.id, attributes: attributes(value.attributes) }
		: undefined;
}
class SqliteRecorder implements SqliteTelemetry, TelemetryPropagation {
	readonly propagation = this;
	readonly metrics: TelemetryMetrics = {
		counter: (name, options) => ({ add: this.measure("counter", name, options) }),
		upDownCounter: (name, options) => ({ add: this.measure("upDownCounter", name, options) }),
		histogram: (name, options) => ({ record: this.measure("histogram", name, options) }),
	};
	droppedSpans = 0;
	droppedMeasurements = 0;
	readonly #scope = crypto.randomUUID();
	#sequence = 0;
	readonly #spans: SqliteValue[][] = [];
	readonly #metrics = new Map<string, Metric>();
	#inFlight = 0;
	#stopped = false;
	#failure: { error: unknown } | undefined;
	#writing: Promise<void> | undefined;
	#closing: Promise<void> | undefined;
	readonly #timer: ReturnType<typeof setInterval>;
	readonly db: SqliteDatabase;
	readonly retention: number;
	readonly capacity: number;
	constructor(db: SqliteDatabase, retention: number, capacity: number) {
		this.db = db;
		this.retention = retention;
		this.capacity = capacity;
		this.#timer = setInterval(() => {
			if (!this.#writing) void this.flush().catch(() => {});
		}, 1000);
		this.#timer.unref?.();
	}
	readonly getTrace: TelemetryStore["getTrace"] = (id) => getTrace(this.db, id);
	readonly findTraces: TelemetryStore["findTraces"] = (query) => findTraces(this.db, query);
	readonly findMetrics: TelemetryStore["findMetrics"] = (query) => findMetrics(this.db, query);
	inject(context: TelemetryContext): TelemetryCarrier | undefined {
		const identity = identities.get(context);
		return identity ? { [spanKey]: identity.id, [traceKey]: identity.traceId } : undefined;
	}
	extract(carrier: TelemetryCarrier | undefined): TelemetryContext {
		const id = carrier?.[spanKey],
			traceId = carrier?.[traceKey];
		if (typeof id !== "string" || typeof traceId !== "string") return this;
		const parent: TelemetryContext = {
			metrics: this.metrics,
			propagation: this,
			startSpan: (options, callback) => this.start({ id, traceId }, options, callback),
		};
		identities.set(parent, { id, traceId });
		return parent;
	}
	startSpan<T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> {
		return this.start(undefined, options, callback);
	}
	private inert<T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> {
		return NOOP_TELEMETRY_CONTEXT.startSpan(options, (span) =>
			callback({ ...span, metrics: this.metrics, propagation: this, startSpan: (o, c) => this.inert(o, c) }),
		);
	}
	private async start<T>(
		parent: Identity | undefined,
		options: SpanOptions,
		callback: (span: TelemetrySpan) => T | Promise<T>,
	): Promise<T> {
		if (this.#stopped) return this.inert(options, callback);
		const id = `${this.#scope}:${++this.#sequence}`,
			identity = { id, traceId: parent?.traceId ?? id };
		let values = attributes(options.attributes);
		const links: NonNullable<ReturnType<typeof link>>[] = [];
		for (const value of options.links ?? []) {
			const next = link(value);
			if (next) links.push(next);
		}
		const name = options.name,
			started = Date.now(),
			clock = performance.now();
		const events: { name: string; time_ms: number; attributes: SpanAttributes }[] = [];
		let status: SpanStatus = { status: "ok" },
			explicit = false,
			settled = false;
		const update = (fn: () => void) => {
			if (!settled && !this.#stopped) fn();
		};
		const span: TelemetrySpan = {
			metrics: this.metrics,
			propagation: this,
			startSpan: (o, c) => (settled ? this.inert(o, c) : this.start(identity, o, c)),
			addLink: (value) =>
				update(() => {
					const next = link(value);
					if (next) links.push(next);
				}),
			addEvent: (name, attrs) =>
				update(() => {
					events.push({ name, time_ms: performance.now() - clock, attributes: attributes(attrs) });
				}),
			setAttributes: (attrs) =>
				update(() => {
					values = { ...values, ...attributes(attrs) };
				}),
			setStatus: (value) =>
				update(() => {
					status =
						value.status === "ok"
							? { status: "ok" }
							: { status: "error", ...(value.error ? { error: { ...value.error } } : {}) };
					explicit = true;
				}),
		};
		identities.set(span, identity);
		try {
			return await callback(span);
		} catch (error) {
			if (!explicit)
				status =
					error instanceof Error
						? { status: "error", error: { name: error.name, message: error.message } }
						: { status: "error" };
			throw error;
		} finally {
			settled = true;
			if (!this.#stopped) {
				if (this.#spans.length >= this.capacity) this.droppedSpans++;
				else
					this.#spans.push([
						id,
						identity.traceId,
						parent?.id ?? null,
						name,
						started,
						started + performance.now() - clock,
						JSON.stringify(values),
						JSON.stringify(events),
						JSON.stringify(links),
						JSON.stringify(status),
					]);
			}
		}
	}
	private measure(
		kind: Metric["kind"],
		name: string,
		options?: InstrumentOptions,
	): (value: number, attrs?: SpanAttributes) => void {
		const unit = options?.unit ?? null;
		return (value, attrs) => {
			if (this.#stopped) return;
			const copied = attributes(attrs);
			const encoded = JSON.stringify(
				Object.fromEntries(
					Object.keys(copied)
						.sort()
						.map((key) => [key, copied[key]]),
				),
			);
			const key = JSON.stringify([name, kind, unit, encoded]),
				interval = intervalStart(),
				pending = `${interval}:${key}`;
			const previous = this.#metrics.get(pending);
			if (!previous && this.#metrics.size + this.#inFlight >= this.capacity) {
				this.droppedMeasurements++;
				return;
			}
			this.#metrics.set(pending, {
				interval,
				key,
				name,
				kind,
				unit,
				attributes: encoded,
				count: (previous?.count ?? 0) + 1,
				sum: (previous?.sum ?? 0) + value,
				min: Math.min(previous?.min ?? value, value),
				max: Math.max(previous?.max ?? value, value),
			});
		};
	}
	flush(): Promise<void> {
		return this.#closing ?? this.drain(false);
	}
	close(): Promise<void> {
		if (!this.#closing) {
			this.#stopped = true;
			clearInterval(this.#timer);
			this.#closing = this.drain(true);
		}
		return this.#closing;
	}
	private async drain(partial: boolean): Promise<void> {
		while (this.#writing) await this.#writing;
		if (this.#failure) throw this.#failure.error;
		const spans = this.#spans.slice(),
			metrics: Metric[] = [];
		const completed = intervalStart();
		for (const [key, row] of this.#metrics) {
			if (partial || row.interval < completed) {
				metrics.push(row);
				this.#metrics.delete(key);
			}
		}
		this.#inFlight = metrics.length;
		this.#writing = Promise.resolve()
			.then(() =>
				this.db.transaction(async (tx) => {
					for (const span of spans)
						await tx.run("INSERT INTO telemetry_spans VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", ...span);
					for (const row of metrics)
						await tx.run(
							`INSERT INTO telemetry_metrics VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(interval_ms, series_key) DO UPDATE SET count = count + excluded.count, sum = sum + excluded.sum,
    min = min(min, excluded.min), max = max(max, excluded.max)`,
							row.interval,
							row.key,
							row.name,
							row.kind,
							row.unit,
							row.attributes,
							row.count,
							row.sum,
							row.min,
							row.max,
						);
					const cutoff = Date.now() - this.retention;
					await tx.run("DELETE FROM telemetry_spans WHERE ended_ms < ?", cutoff);
					await tx.run("DELETE FROM telemetry_metrics WHERE interval_ms < ?", cutoff);
				}),
			)
			.then(() => {
				this.#spans.splice(0, spans.length);
			})
			.catch((error: unknown) => {
				this.#failure = { error };
				this.#stopped = true;
				clearInterval(this.#timer);
				this.#spans.length = 0;
				this.#metrics.clear();
				throw error;
			})
			.finally(() => {
				this.#writing = undefined;
				this.#inFlight = 0;
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
	await applySqliteMigrations(
		db,
		[
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
		],
		{ table: "telemetry_schema" },
	);
	return new SqliteRecorder(db, retention, capacity);
}
