import type { MetricQuery, SpanAttributes, StoredMetric, StoredSpan, StoredTrace, TraceQuery } from "@axi/telemetry";
import type { SqliteDatabase, SqliteValue } from "../sqlite/index.ts";

type Row = {
	id: string;
	trace_id: string;
	parent_id: string | null;
	name: string;
	started_ms: number;
	ended_ms: number;
	attributes: string;
	events: string;
	links: string;
	status: string;
};
function decode(row: Row): StoredSpan {
	const events: { name: string; time_ms: number; attributes: SpanAttributes }[] = JSON.parse(row.events);
	const links: { trace_id: string; span_id: string; attributes?: SpanAttributes }[] = JSON.parse(row.links);
	return {
		id: row.id,
		traceId: row.trace_id,
		...(row.parent_id === null ? {} : { parentId: row.parent_id }),
		name: row.name,
		startedMs: row.started_ms,
		endedMs: row.ended_ms,
		attributes: JSON.parse(row.attributes),
		status: JSON.parse(row.status),
		events: events.map((event) => ({ name: event.name, timeMs: event.time_ms, attributes: event.attributes })),
		links: links.map((link) => ({
			traceId: link.trace_id,
			spanId: link.span_id,
			...(link.attributes === undefined ? {} : { attributes: link.attributes }),
		})),
	};
}
function equalities(filter: TraceQuery["attributes"], column: string, parameters: SqliteValue[]): string {
	const clauses: string[] = [];
	for (const [key, value] of Object.entries(filter ?? {})) {
		const type =
			typeof value === "string"
				? "item.type = 'text'"
				: typeof value === "number"
					? "item.type IN ('integer','real')"
					: `item.type = '${value ? "true" : "false"}'`;
		clauses.push(`EXISTS (SELECT 1 FROM json_each(${column}) item WHERE item.key = ? AND ${type} AND item.value = ?)`);
		parameters.push(key, typeof value === "boolean" ? Number(value) : value);
	}
	return clauses.join(" AND ") || "1";
}
export async function getTrace(db: SqliteDatabase, traceId: string): Promise<StoredTrace | undefined> {
	const rows = await db.all<Row>("SELECT * FROM telemetry_spans WHERE trace_id = ? ORDER BY started_ms, id", traceId);
	return rows.length ? { traceId, spans: rows.map(decode) } : undefined;
}
export async function findTraces(
	db: SqliteDatabase,
	query: TraceQuery = {},
): Promise<{ traces: readonly StoredTrace[]; cursor?: string }> {
	const clauses: string[] = [],
		parameters: SqliteValue[] = [];
	if (query.name !== undefined) {
		clauses.push(
			"(SELECT name FROM telemetry_spans s WHERE s.trace_id = heads.trace_id ORDER BY started_ms, id LIMIT 1) = ?",
		);
		parameters.push(query.name);
	}
	if (query.startMin !== undefined) {
		clauses.push("started_ms >= ?");
		parameters.push(query.startMin);
	}
	if (query.startMax !== undefined) {
		clauses.push("started_ms <= ?");
		parameters.push(query.startMax);
	}
	if (query.errors)
		clauses.push(
			"EXISTS (SELECT 1 FROM telemetry_spans s WHERE s.trace_id = heads.trace_id AND json_extract(s.status,'$.status') = 'error')",
		);
	if (query.attributes)
		clauses.push(
			`EXISTS (SELECT 1 FROM telemetry_spans s WHERE s.trace_id = heads.trace_id AND ${equalities(query.attributes, "s.attributes", parameters)})`,
		);
	if (query.cursor !== undefined) {
		const cursor = JSON.parse(query.cursor);
		clauses.push("(started_ms < ? OR (started_ms = ? AND trace_id > ?))");
		parameters.push(cursor[0], cursor[0], cursor[1]);
	}
	const limit = query.limit ?? 20;
	return db.transaction(async (tx) => {
		const heads = await tx.all<{ trace_id: string; started_ms: number }>(
			`WITH heads AS (SELECT trace_id, min(started_ms) AS started_ms FROM telemetry_spans GROUP BY trace_id)
   SELECT * FROM heads WHERE ${clauses.join(" AND ") || "1"} ORDER BY started_ms DESC, trace_id LIMIT ?`,
			...parameters,
			limit + 1,
		);
		const more = heads.length > limit;
		const selected = heads.slice(0, limit);
		if (!selected.length) return { traces: [] };
		const rows = await tx.all<Row>(
			"SELECT * FROM telemetry_spans WHERE trace_id IN (SELECT value FROM json_each(?)) ORDER BY started_ms, id",
			JSON.stringify(selected.map((head) => head.trace_id)),
		);
		const grouped = new Map<string, StoredSpan[]>();
		for (const row of rows) {
			const group = grouped.get(row.trace_id);
			if (group) group.push(decode(row));
			else grouped.set(row.trace_id, [decode(row)]);
		}
		const last = selected.at(-1)!;
		return {
			traces: selected.map((head) => ({ traceId: head.trace_id, spans: grouped.get(head.trace_id)! })),
			...(more ? { cursor: JSON.stringify([last.started_ms, last.trace_id]) } : {}),
		};
	});
}
export async function findMetrics(db: SqliteDatabase, query: MetricQuery): Promise<readonly StoredMetric[]> {
	const parameters: SqliteValue[] = [query.name],
		clauses = ["name = ?"];
	if (query.startMin !== undefined) {
		clauses.push("interval_ms >= ?");
		parameters.push(query.startMin);
	}
	if (query.startMax !== undefined) {
		clauses.push("interval_ms <= ?");
		parameters.push(query.startMax);
	}
	clauses.push(equalities(query.attributes, "attributes", parameters));
	const rows = await db.all<{
		interval_ms: number;
		name: string;
		kind: StoredMetric["kind"];
		unit: string | null;
		attributes: string;
		count: number;
		sum: number;
		min: number;
		max: number;
	}>(`SELECT * FROM telemetry_metrics WHERE ${clauses.join(" AND ")} ORDER BY interval_ms, series_key`, ...parameters);
	return rows.map((row) => ({
		intervalMs: row.interval_ms,
		name: row.name,
		kind: row.kind,
		...(row.unit === null ? {} : { unit: row.unit }),
		attributes: JSON.parse(row.attributes),
		count: row.count,
		sum: row.sum,
		min: row.min,
		max: row.max,
	}));
}
