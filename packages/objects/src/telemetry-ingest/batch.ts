import { Type, type TUnsafe } from "typebox";
import type { StoredSpan, StoredMetric } from "@axi/telemetry";
import { arr, bool, hostKind, int, lit, method, num, obj, opt, remote, str, union, type TSchema } from "../contracts/index.ts";

export const PAGE_BATCH_SPANS = 100;
export const WORKER_BATCH_ROWS = 1000;
const identifier = (max: number) => str({ min: 1, max, pattern: "^[\\x21-\\x7e]+$" });
const text = (max: number, min = 0) => str({ min, max, pattern: "^[^\\u0000-\\u001f\\u007f-\\u009f]*$" });

function attributes<S extends TSchema>(max: number, value: S) {
	return Type.Record(str({ pattern: "^[^\\u0000-\\u001f\\u007f-\\u009f]{1,64}$" }), value, { maxProperties: max, additionalProperties: false });
}

function span(page: boolean): TUnsafe<StoredSpan> {
	const id = identifier(page ? 128 : 256);
	const name = text(page ? 128 : 1024, 1);
	const values = page ? union([text(256), num(), bool()])
		: union([str({ max: 65536 }), num(), bool(), arr(union([str(), num()]))]);
	const attrs = attributes(page ? 32 : 256, values);
	return obj({
		id, traceId: id, parentId: opt(id), name,
		startedMs: num({ min: 0 }), endedMs: num({ min: 0 }), attributes: attrs,
		status: union([obj({ status: lit("ok") }), obj({ status: lit("error"), error: opt(obj({ name: text(64), message: text(500) })) })]),
		events: arr(obj({ name, timeMs: num({ min: 0 }), attributes: attrs }), { max: page ? 16 : 1024 }),
		links: arr(obj({ traceId: id, spanId: id, attributes: opt(attrs) }), { max: page ? 8 : 256 }),
	}) as unknown as TUnsafe<StoredSpan>;
}

const metric = obj({
	intervalMs: int({ min: 0 }), name: text(256, 1), unit: opt(text(64)),
	kind: union([lit("counter"), lit("upDownCounter"), lit("histogram")]),
	attributes: attributes(64, union([str({ max: 4096 }), num(), bool()])),
	count: int({ min: 0 }), sum: num(), min: num(), max: num(),
}) as unknown as TUnsafe<StoredMetric>;
const receipt = obj({ written: int(), dropped: int() });
export const PageBatch = obj({ spans: arr(span(true), { max: PAGE_BATCH_SPANS }) });
export const WorkerBatch = obj({ spans: arr(span(false), { max: WORKER_BATCH_ROWS }), metrics: arr(metric, { max: WORKER_BATCH_ROWS }) });
const Server = hostKind("server");
export const PageTelemetry = remote("objects.telemetry.page", {
	version: 1, params: {}, hostAddress: () => Server(),
	variants: { main: { methods: { ingest: method(PageBatch, receipt) } } },
});
export const WorkerTelemetry = remote("objects.telemetry.worker", {
	version: 1, params: {}, hostAddress: () => Server(),
	variants: { worker: { methods: { ingest: method(WorkerBatch, receipt) } }, other: {} },
});
