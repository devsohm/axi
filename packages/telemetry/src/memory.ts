import type {
	MetricQuery,
	TraceQuery,
	StoredMetric,
	StoredSpan,
	StoredTrace,
	TelemetryStore,
	SpanAttributes,
	SpanLink,
	SpanOptions,
	SpanStatus,
	TelemetryCarrier,
	TelemetryContext,
	TelemetryPropagation,
	TelemetrySpan,
} from "./index.ts";
import type {
	HistogramOptions,
	InstrumentOptions,
	TelemetryCounter,
	TelemetryHistogram,
	TelemetryMetrics,
	TelemetryUpDownCounter,
} from "./metrics.ts";
import { NOOP_TELEMETRY_CONTEXT } from "./noop.ts";

export interface RecordedTelemetryEvent {
	readonly name: string;
	readonly attributes: Readonly<SpanAttributes>;
}
export interface RecordedTelemetryLink {
	readonly context: Readonly<TelemetryCarrier>;
	readonly attributes: Readonly<SpanAttributes>;
}
export interface RecordedTelemetryMeasurement {
	readonly kind: "counter" | "upDownCounter" | "histogram";
	readonly name: string;
	readonly description?: string;
	readonly unit?: string;
	readonly boundaries?: readonly number[];
	readonly value: number;
	readonly attributes: Readonly<SpanAttributes>;
	readonly context: Readonly<TelemetryCarrier> | null;
}
export interface RecordedTelemetrySpan {
	readonly id: number;
	readonly parentId: number | null;
	readonly context: Readonly<TelemetryCarrier>;
	readonly parentContext: Readonly<TelemetryCarrier> | null;
	readonly links: readonly RecordedTelemetryLink[];
	readonly name: string;
	readonly attributes: Readonly<SpanAttributes>;
	readonly events: readonly RecordedTelemetryEvent[];
	readonly status: SpanStatus;
	readonly settled: boolean;
	readonly endSequence?: number;
}
type Recording = {
	startedMs: number;
	clock: number;
	endedMs: number;
	id: number;
	parentId: number | null;
	context: TelemetryCarrier;
	parentContext: TelemetryCarrier | null;
	links: RecordedTelemetryLink[];
	name: string;
	attributes: SpanAttributes;
	events: (RecordedTelemetryEvent & { timeMs: number })[];
	status: SpanStatus;
	explicit: boolean;
	settled: boolean;
	endSequence?: number;
};
type State = {
	metrics: TelemetryMetrics;
	propagation: TelemetryPropagation;
	scope: string;
	spans: Recording[];
	measurements: (RecordedTelemetryMeasurement & { intervalMs: number })[];
	nextSpanId: number;
	nextEndSequence: number;
};
type Parent = { context: TelemetryCarrier; id: number | null; record?: Recording };
const scopeKey = "axi-memory-scope";
const spanKey = "axi-memory-span";
const traceKey = "axi-memory-trace";
const carriers = new WeakMap<TelemetryContext, TelemetryCarrier>();
function linkSnapshot(link: SpanLink): RecordedTelemetryLink | undefined {
	const carrier = carriers.get(link.context);
	return carrier ? { context: { ...carrier }, attributes: attributes(link.attributes) } : undefined;
}
function attributes(source?: SpanAttributes): SpanAttributes {
	return Object.fromEntries(
		Object.entries(source ?? {}).flatMap(([name, value]) =>
			value === undefined ? [] : [[name, Array.isArray(value) ? [...value] : value]],
		),
	);
}
function status(value: SpanStatus): SpanStatus {
	if (value.status === "ok") return { status: "ok" };
	return value.error
		? { status: "error", error: { name: value.error.name, message: value.error.message } }
		: { status: "error" };
}
function failure(error: unknown): SpanStatus {
	if (error instanceof Error) return { status: "error", error: { name: error.name, message: error.message } };
	return { status: "error" };
}
function startInert<T>(
	state: State,
	options: SpanOptions,
	callback: (span: TelemetrySpan) => T | Promise<T>,
): Promise<T> {
	return NOOP_TELEMETRY_CONTEXT.startSpan(options, (span) =>
		callback({
			...span,
			metrics: state.metrics,
			propagation: state.propagation,
			startSpan: (child, fn) => startInert(state, child, fn),
		}),
	);
}
async function start<T>(
	state: State,
	parent: Parent | undefined,
	options: SpanOptions,
	callback: (span: TelemetrySpan) => T | Promise<T>,
): Promise<T> {
	if (parent?.record?.settled) return startInert(state, options, callback);
	const name = options.name,
		initialAttributes = attributes(options.attributes);
	const links: RecordedTelemetryLink[] = [];
	for (const link of options.links ?? []) {
		const snapshot = linkSnapshot(link);
		if (snapshot) links.push(snapshot);
	}
	const id = state.nextSpanId++;
	const recording: Recording = {
		startedMs: Date.now(),
		clock: performance.now(),
		endedMs: 0,
		id,
		parentId: parent?.id ?? null,
		context: {
			[scopeKey]: state.scope,
			[spanKey]: String(id),
			[traceKey]: parent?.context[traceKey] ?? `${state.scope}:${id}`,
		},
		parentContext: parent ? { ...parent.context } : null,
		links,
		name,
		attributes: initialAttributes,
		events: [],
		status: { status: "ok" },
		explicit: false,
		settled: false,
	};
	state.spans.push(recording);
	const span: TelemetrySpan = {
		metrics: state.metrics,
		propagation: state.propagation,
		startSpan: (child, fn) =>
			start(state, { context: recording.context, id: recording.id, record: recording }, child, fn),
		addLink(link) {
			if (recording.settled) return;
			const snapshot = linkSnapshot(link);
			if (snapshot) recording.links.push(snapshot);
		},
		addEvent(name, values) {
			if (recording.settled) return;
			recording.events.push({ name, timeMs: performance.now() - recording.clock, attributes: attributes(values) });
		},
		setAttributes(values) {
			if (recording.settled) return;
			recording.attributes = { ...recording.attributes, ...attributes(values) };
		},
		setStatus(value) {
			if (recording.settled) return;
			recording.status = status(value);
			recording.explicit = true;
		},
	};
	carriers.set(span, recording.context);
	try {
		return await callback(span);
	} catch (error) {
		if (!recording.explicit) recording.status = failure(error);
		throw error;
	} finally {
		recording.settled = true;
		recording.endedMs = recording.startedMs + performance.now() - recording.clock;
		recording.endSequence = state.nextEndSequence++;
	}
}
function recorder(
	state: State,
	kind: RecordedTelemetryMeasurement["kind"],
	name: string,
	options?: HistogramOptions,
): (value: number, values?: SpanAttributes, context?: TelemetryContext) => void {
	const description = options?.description;
	const unit = options?.unit;
	const boundaries = kind === "histogram" && options?.boundaries !== undefined ? [...options.boundaries] : undefined;
	const metadata = {
		kind,
		name,
		...(description === undefined ? {} : { description }),
		...(unit === undefined ? {} : { unit }),
		...(boundaries === undefined ? {} : { boundaries }),
	};
	return (value, values, context) => {
		const carrier = context === undefined ? undefined : carriers.get(context);
		state.measurements.push({
			intervalMs: Math.floor(Date.now() / 10000) * 10000,
			...metadata,
			value,
			attributes: attributes(values),
			context: carrier ? { ...carrier } : null,
		});
	};
}
export class InMemoryTelemetryContext
	implements TelemetryContext, TelemetryPropagation, TelemetryMetrics, TelemetryStore
{
	readonly metrics: TelemetryMetrics = this;
	readonly propagation: TelemetryPropagation = this;
	private readonly state: State = {
		metrics: this,
		propagation: this,
		scope: crypto.randomUUID(),
		spans: [],
		measurements: [],
		nextSpanId: 1,
		nextEndSequence: 1,
	};
	startSpan<T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> {
		return start(this.state, undefined, options, callback);
	}
	inject(context: TelemetryContext): TelemetryCarrier | undefined {
		const carrier = carriers.get(context);
		return carrier ? { ...carrier } : undefined;
	}
	extract(carrier: TelemetryCarrier | undefined): TelemetryContext {
		const scope = carrier?.[scopeKey],
			span = carrier?.[spanKey],
			trace = carrier?.[traceKey];
		if (typeof scope !== "string" || typeof span !== "string" || typeof trace !== "string") return this;
		const context = { [scopeKey]: scope, [spanKey]: span, [traceKey]: trace };
		const id = scope === this.state.scope ? Number(span) : null;
		const parent: TelemetryContext = {
			metrics: this,
			propagation: this,
			startSpan: (options, callback) => start(this.state, { context, id }, options, callback),
		};
		carriers.set(parent, context);
		return parent;
	}
	counter(name: string, options?: InstrumentOptions): TelemetryCounter {
		return { add: recorder(this.state, "counter", name, options) };
	}
	upDownCounter(name: string, options?: InstrumentOptions): TelemetryUpDownCounter {
		return { add: recorder(this.state, "upDownCounter", name, options) };
	}
	histogram(name: string, options?: HistogramOptions): TelemetryHistogram {
		return { record: recorder(this.state, "histogram", name, options) };
	}
	private storedSpans(): StoredSpan[] {
		const identity = (carrier: Readonly<TelemetryCarrier>) => `${carrier[scopeKey]}:${carrier[spanKey]}`;
		return this.state.spans
			.filter((item) => item.settled)
			.map(
				(item): StoredSpan => ({
					id: identity(item.context),
					traceId: item.context[traceKey]!,
					...(item.parentContext ? { parentId: identity(item.parentContext) } : {}),
					name: item.name,
					startedMs: item.startedMs,
					endedMs: item.endedMs,
					attributes: attributes(item.attributes),
					status: status(item.status),
					events: item.events.map((event) => ({
						name: event.name,
						timeMs: event.timeMs,
						attributes: attributes(event.attributes),
					})),
					links: item.links.map((link) => ({
						traceId: link.context[traceKey]!,
						spanId: identity(link.context),
						attributes: attributes(link.attributes),
					})),
				}),
			)
			.sort((a, b) => a.startedMs - b.startedMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	}
	async getTrace(traceId: string): Promise<StoredTrace | undefined> {
		const spans = this.storedSpans().filter((span) => span.traceId === traceId);
		return spans.length ? { traceId, spans } : undefined;
	}
	async findTraces(query: TraceQuery = {}): Promise<{ traces: readonly StoredTrace[]; cursor?: string }> {
		const grouped = new Map<string, StoredSpan[]>();
		for (const span of this.storedSpans()) {
			const group = grouped.get(span.traceId);
			if (group) group.push(span);
			else grouped.set(span.traceId, [span]);
		}
		const after = query.cursor === undefined ? undefined : JSON.parse(query.cursor);
		const matches = [...grouped]
			.filter(([id, spans]) => {
				const first = spans[0]!;
				return (
					(query.name === undefined || first.name === query.name) &&
					(query.startMin === undefined || first.startedMs >= query.startMin) &&
					(query.startMax === undefined || first.startedMs <= query.startMax) &&
					(!after || first.startedMs < after[0] || (first.startedMs === after[0] && id > after[1])) &&
					(!query.errors || spans.some((span) => span.status.status === "error")) &&
					(!query.attributes ||
						spans.some((span) =>
							Object.entries(query.attributes!).every(([key, value]) => span.attributes[key] === value),
						))
				);
			})
			.sort(([aid, a], [bid, b]) => b[0]!.startedMs - a[0]!.startedMs || (aid < bid ? -1 : aid > bid ? 1 : 0));
		const limit = query.limit ?? 20;
		const traces = matches.slice(0, limit).map(([traceId, spans]) => ({ traceId, spans }));
		const last = traces.at(-1)!;
		return {
			traces,
			...(matches.length > limit ? { cursor: JSON.stringify([last.spans[0]!.startedMs, last.traceId]) } : {}),
		};
	}
	async findMetrics(query: MetricQuery): Promise<readonly StoredMetric[]> {
		return this.state.measurements
			.filter(
				(row) =>
					row.name === query.name &&
					(query.startMin === undefined || row.intervalMs >= query.startMin) &&
					(query.startMax === undefined || row.intervalMs <= query.startMax) &&
					Object.entries(query.attributes ?? {}).every(([key, value]) => row.attributes[key] === value),
			)
			.map((row) => ({
				intervalMs: row.intervalMs,
				name: row.name,
				kind: row.kind,
				...(row.unit === undefined ? {} : { unit: row.unit }),
				attributes: attributes(row.attributes),
				count: 1,
				sum: row.value,
				min: row.value,
				max: row.value,
			}));
	}
	getMetrics(): readonly RecordedTelemetryMeasurement[] {
		return this.state.measurements.map(({ intervalMs: _interval, ...item }) => ({
			...item,
			...(item.boundaries === undefined ? {} : { boundaries: [...item.boundaries] }),
			attributes: attributes(item.attributes),
			context: item.context ? { ...item.context } : null,
		}));
	}
	getSpans(): readonly RecordedTelemetrySpan[] {
		return this.state.spans.map((item) => ({
			id: item.id,
			parentId: item.parentId,
			context: { ...item.context },
			parentContext: item.parentContext ? { ...item.parentContext } : null,
			links: item.links.map((link) => ({ context: { ...link.context }, attributes: attributes(link.attributes) })),
			name: item.name,
			attributes: attributes(item.attributes),
			events: item.events.map((event) => ({ name: event.name, attributes: attributes(event.attributes) })),
			status: status(item.status),
			settled: item.settled,
			...(item.endSequence === undefined ? {} : { endSequence: item.endSequence }),
		}));
	}
}
