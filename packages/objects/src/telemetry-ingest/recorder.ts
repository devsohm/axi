import {
	NOOP_TELEMETRY_CONTEXT,
	telemetryNow,
	type InstrumentOptions,
	type SpanAttributes,
	type SpanLink,
	type SpanOptions,
	type SpanStatus,
	type StoredMetric,
	type StoredSpan,
	type TelemetryCarrier,
	type TelemetryContext,
	type TelemetryMetrics,
	type TelemetrySpan,
} from "@axi/telemetry";

export type TelemetryBatch = { readonly spans: StoredSpan[]; readonly metrics: StoredMetric[] };
type Identity = { id: string; traceId: string };
const identities = new WeakMap<TelemetryContext, Identity>();
const spanKey = "axi-sqlite-span",
	traceKey = "axi-sqlite-trace";
export const INTERVAL_MS = 10000;
const interval = () => Math.floor(Date.now() / INTERVAL_MS) * INTERVAL_MS;
const rounded = (ms: number) => Math.round(ms * 1000) / 1000;

export function sortedAttributes(values: SpanAttributes): SpanAttributes {
	return Object.fromEntries(
		Object.entries(values).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
	);
}
export function seriesKey(metric: StoredMetric): string {
	return JSON.stringify([
		metric.name,
		metric.kind,
		metric.unit ?? null,
		JSON.stringify(sortedAttributes(metric.attributes)),
	]);
}
function attributes(source: SpanAttributes = {}): SpanAttributes {
	return Object.fromEntries(
		Object.entries(source)
			.filter(([, value]) => value !== undefined)
			.map(([key, value]) => [key, Array.isArray(value) ? [...value] : value]),
	);
}
function link(source: SpanLink): StoredSpan["links"][number] | undefined {
	const identity = identities.get(source.context);
	return identity
		? { traceId: identity.traceId, spanId: identity.id, attributes: attributes(source.attributes) }
		: undefined;
}

export class TelemetryRecorder implements TelemetryContext {
	readonly propagation = this;
	readonly metrics: TelemetryMetrics = {
		counter: (name, options) => ({ add: this.measure("counter", name, options) }),
		upDownCounter: (name, options) => ({ add: this.measure("upDownCounter", name, options) }),
		histogram: (name, options) => ({ record: this.measure("histogram", name, options) }),
	};
	droppedSpans = 0;
	droppedMeasurements = 0;
	readonly #scope: () => string;
	readonly #capacity: number;
	#prefix?: string;
	#sequence = 0;
	#stopped = false;
	#spans: StoredSpan[] = [];
	readonly #metrics = new Map<string, StoredMetric>();
	#takenSpans = 0;
	#takenMetrics = 0;

	constructor(scope: () => string, capacity: number) {
		this.#scope = scope;
		this.#capacity = capacity;
	}
	get stopped(): boolean {
		return this.#stopped;
	}
	get queuedSpans(): number {
		return this.#spans.length;
	}
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
	pending(partial: boolean): boolean {
		return (
			this.#spans.length > 0 || [...this.#metrics.values()].some((metric) => partial || metric.intervalMs < interval())
		);
	}
	take(partial: boolean, limit = Infinity): TelemetryBatch {
		const spans = this.#spans.slice(0, limit);
		this.#spans = this.#spans.slice(limit);
		const metrics: StoredMetric[] = [];
		const current = interval();
		for (const [key, metric] of this.#metrics)
			if (partial || metric.intervalMs < current) {
				metrics.push(metric);
				this.#metrics.delete(key);
			}
		this.#takenSpans = spans.length;
		this.#takenMetrics = metrics.length;
		return { spans, metrics };
	}
	release(): void {
		this.#takenSpans = this.#takenMetrics = 0;
	}
	ingest(batch: TelemetryBatch): number {
		if (this.#stopped) return 0;
		let accepted = 0;
		for (const span of batch.spans) {
			if (this.#spans.length + this.#takenSpans < this.#capacity) {
				this.#spans.push(span);
				accepted++;
			} else this.droppedSpans++;
		}
		for (const metric of batch.metrics) this.merge(metric);
		return accepted;
	}
	stop(mode: "keep" | "discard"): void {
		this.#stopped = true;
		if (mode === "discard") {
			this.#spans = [];
			this.#metrics.clear();
		}
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
		let values = attributes(options.attributes);
		const links = (options.links ?? []).flatMap((value) => {
			const item = link(value);
			return item ? [item] : [];
		});
		this.#prefix ??= this.#scope();
		const id = `${this.#prefix}:${++this.#sequence}`,
			identity = { id, traceId: parent?.traceId ?? id };
		const started = telemetryNow(),
			clock = performance.now();
		const events: StoredSpan["events"][number][] = [];
		let status: SpanStatus = { status: "ok" },
			explicit = false,
			settled = false;
		const update = (action: () => void) => {
			if (!settled && !this.#stopped) action();
		};
		const span: TelemetrySpan = {
			metrics: this.metrics,
			propagation: this,
			startSpan: (o, c) => (settled ? this.inert(o, c) : this.start(identity, o, c)),
			addLink: (value) =>
				update(() => {
					const item = link(value);
					if (item) links.push(item);
				}),
			addEvent: (name, attrs) =>
				update(() => {
					events.push({ name, timeMs: rounded(performance.now() - clock), attributes: attributes(attrs) });
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
			if (!this.#stopped) this.ingest({
				spans: [
					{
						id,
						traceId: identity.traceId,
						...(parent ? { parentId: parent.id } : {}),
						name: options.name,
						startedMs: started,
						endedMs: rounded(started + performance.now() - clock),
						attributes: values,
						events,
						links,
						status,
					},
				],
				metrics: [],
			});
		}
	}
	private measure(
		kind: StoredMetric["kind"],
		name: string,
		options?: InstrumentOptions,
	): (value: number, attrs?: SpanAttributes) => void {
		const unit = options?.unit;
		return (value, attrs) =>
			this.merge({
				name,
				kind,
				...(unit === undefined ? {} : { unit }),
				intervalMs: interval(),
				attributes: sortedAttributes(attributes(attrs)),
				count: 1,
				sum: value,
				min: value,
				max: value,
			});
	}
	private merge(metric: StoredMetric): void {
		if (this.#stopped) return;
		const key = `${metric.intervalMs}:${seriesKey(metric)}`,
			previous = this.#metrics.get(key);
		if (!previous && this.#metrics.size + this.#takenMetrics >= this.#capacity) {
			this.droppedMeasurements++;
			return;
		}
		this.#metrics.set(key, {
			...metric,
			count: (previous?.count ?? 0) + metric.count,
			sum: (previous?.sum ?? 0) + metric.sum,
			min: Math.min(previous?.min ?? metric.min, metric.min),
			max: Math.max(previous?.max ?? metric.max, metric.max),
		});
	}
}
