import type {
	AttributeValue,
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
	id: number;
	parentId: number | null;
	context: TelemetryCarrier;
	parentContext: TelemetryCarrier | null;
	links: RecordedTelemetryLink[];
	name: string;
	attributes: SpanAttributes;
	events: RecordedTelemetryEvent[];
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
	measurements: RecordedTelemetryMeasurement[];
	nextSpanId: number;
	nextEndSequence: number;
};
type Parent = { context: TelemetryCarrier; id: number | null; record?: Recording };
const scopeKey = "axi-memory-scope";
const spanKey = "axi-memory-span";
const carriers = new WeakMap<TelemetryContext, TelemetryCarrier>();
function linkSnapshot(link: SpanLink): RecordedTelemetryLink | undefined {
	try {
		const carrier = carriers.get(link.context);
		return carrier ? { context: { ...carrier }, attributes: attributes(link.attributes) } : undefined;
	} catch {
		return undefined;
	}
}
function attributes(source?: SpanAttributes): SpanAttributes {
	const result: SpanAttributes = {};
	if (source)
		for (const [name, value] of Object.entries(source))
			if (value !== undefined) result[name] = Array.isArray(value) ? ([...value] as AttributeValue) : value;
	return result;
}
function merged(current: SpanAttributes, supplied: SpanAttributes): SpanAttributes {
	const result = attributes(current);
	for (const [name, value] of Object.entries(supplied))
		if (value !== undefined) result[name] = Array.isArray(value) ? ([...value] as AttributeValue) : value;
	return result;
}
function status(value: SpanStatus): SpanStatus {
	if (value.status === "ok") return { status: "ok" };
	return value.error
		? { status: "error", error: { name: value.error.name, message: value.error.message } }
		: { status: "error" };
}
function failure(error: unknown): SpanStatus {
	try {
		if (error instanceof Error) return { status: "error", error: { name: error.name, message: error.message } };
	} catch {
		/* Error inspection must not replace the operation's result. */
	}
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
function start<T>(
	state: State,
	parent: Parent | undefined,
	options: SpanOptions,
	callback: (span: TelemetrySpan) => T | Promise<T>,
): Promise<T> {
	if (parent?.record?.settled) return startInert(state, options, callback);
	let recording: Recording;
	try {
		const name = options.name,
			start = attributes(options.attributes);
		const links: RecordedTelemetryLink[] = [];
		try {
			for (const link of options.links ?? []) {
				const snapshot = linkSnapshot(link);
				if (snapshot) links.push(snapshot);
			}
		} catch {
			/* Link collection failures do not suppress the span. */
		}
		const id = state.nextSpanId++;
		recording = {
			id,
			parentId: parent?.id ?? null,
			context: { [scopeKey]: state.scope, [spanKey]: String(id) },
			parentContext: parent ? { ...parent.context } : null,
			links,
			name,
			attributes: start,
			events: [],
			status: { status: "ok" },
			explicit: false,
			settled: false,
		};
		state.spans.push(recording);
	} catch {
		return startInert(state, options, callback);
	}
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
			try {
				recording.events.push({ name, attributes: attributes(values) });
			} catch {
				/* Telemetry writes are passive. */
			}
		},
		setAttributes(values) {
			if (recording.settled) return;
			try {
				recording.attributes = merged(recording.attributes, values);
			} catch {
				/* Telemetry writes are passive. */
			}
		},
		setStatus(value) {
			if (recording.settled) return;
			try {
				recording.status = status(value);
				recording.explicit = true;
			} catch {
				/* Telemetry writes are passive. */
			}
		},
	};
	carriers.set(span, recording.context);
	let result: T | Promise<T>;
	try {
		result = callback(span);
	} catch (error) {
		settle(state, recording, true, error);
		return Promise.reject(error);
	}
	return Promise.resolve(result).then(
		(value) => {
			settle(state, recording, false);
			return value;
		},
		(error) => {
			settle(state, recording, true, error);
			throw error;
		},
	);
}
function settle(state: State, recording: Recording, failed: boolean, error?: unknown): void {
	if (recording.settled) return;
	if (failed && !recording.explicit) recording.status = failure(error);
	recording.settled = true;
	recording.endSequence = state.nextEndSequence++;
}
function recorder(
	state: State,
	kind: RecordedTelemetryMeasurement["kind"],
	name: string,
	options?: HistogramOptions,
): (value: number, values?: SpanAttributes, context?: TelemetryContext) => void {
	try {
		const description = options?.description;
		const unit = options?.unit;
		const boundaries = kind === "histogram" && options?.boundaries !== undefined ? [...options.boundaries] : undefined;
		if (
			typeof name !== "string" ||
			(description !== undefined && typeof description !== "string") ||
			(unit !== undefined && typeof unit !== "string") ||
			boundaries?.some((value, index) => !Number.isFinite(value) || (index > 0 && value <= boundaries[index - 1]!))
		)
			return () => {};
		const metadata = {
			kind,
			name,
			...(description === undefined ? {} : { description }),
			...(unit === undefined ? {} : { unit }),
			...(boundaries === undefined ? {} : { boundaries }),
		};
		return (value, values, context) => {
			if (!Number.isFinite(value) || (kind === "counter" && value < 0)) return;
			try {
				const carrier = context === undefined ? undefined : carriers.get(context);
				state.measurements.push({
					...metadata,
					value,
					attributes: attributes(values),
					context: carrier ? { ...carrier } : null,
				});
			} catch {
				/* Discard the whole unreadable measurement. */
			}
		};
	} catch {
		return () => {};
	}
}
export class InMemoryTelemetryContext implements TelemetryContext, TelemetryPropagation, TelemetryMetrics {
	readonly metrics = this;
	readonly propagation = this;
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
		try {
			if (!carrier || typeof carrier !== "object" || Array.isArray(carrier)) return this;
			if (!Object.hasOwn(carrier, scopeKey) || !Object.hasOwn(carrier, spanKey)) return this;
			if (Object.values(carrier).some((value) => typeof value !== "string")) return this;
			const scope = carrier[scopeKey];
			const span = carrier[spanKey];
			if (typeof scope !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(scope))
				return this;
			if (typeof span !== "string" || !/^[1-9][0-9]*$/.test(span) || !Number.isSafeInteger(Number(span))) return this;
			const context = { [scopeKey]: scope, [spanKey]: span };
			const id =
				scope === this.state.scope && this.state.spans.some((recording) => recording.id === Number(span))
					? Number(span)
					: null;
			const parent: TelemetryContext = {
				metrics: this,
				propagation: this,
				startSpan: (options, callback) => start(this.state, { context, id }, options, callback),
			};
			carriers.set(parent, context);
			return parent;
		} catch {
			return this;
		}
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
	getMetrics(): readonly RecordedTelemetryMeasurement[] {
		return this.state.measurements.map((item) => ({
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
