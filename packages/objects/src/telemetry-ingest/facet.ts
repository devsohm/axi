import type { SpanAttributes } from "@axi/telemetry";
import type { Principal } from "../data/index.ts";
import { defineFacet, type Facet } from "../host/index.ts";
import { PageTelemetry, WorkerTelemetry } from "./batch.ts";
import type { TelemetryBatch } from "./recorder.ts";

export const PAGE_SPANS_PER_MINUTE = 1200;
export type TelemetryIngestTarget = { ingest(batch: TelemetryBatch): number };
export type TelemetryIngestOptions<P extends Principal> = {
	readonly target: TelemetryIngestTarget;
	readonly workerHost: (principal: P) => string | undefined;
	readonly principalAttributes: (principal: P) => Readonly<SpanAttributes>;
};

export function telemetryIngestFacet<P extends Principal>(options: TelemetryIngestOptions<P>): Facet<P> {
	return defineFacet<P>((host) => {
		host.serve(PageTelemetry, (_params, principal) => {
			const stamp = { ...options.principalAttributes(principal), "objects.host": "browser" };
			const minutes = new Map<string, { since: number; used: number }>();
			return { variant: "main", members: { ingest: async ({ spans }, ctx) => {
				const now = Date.now();
				let budget = minutes.get(ctx.incarnation);
				if (!budget || now - budget.since >= 60000) {
					minutes.delete(ctx.incarnation);
					if (minutes.size >= 1000) {
						const first = minutes.keys().next();
						if (!first.done) minutes.delete(first.value);
					}
					budget = { since: now, used: 0 };
					minutes.set(ctx.incarnation, budget);
				}
				const prefix = `browser:${ctx.incarnation}:`;
				const own = spans.filter((span) => {
					if (budget.used >= PAGE_SPANS_PER_MINUTE || span.endedMs < span.startedMs) return false;
					if (![span.id, span.traceId, span.parentId ?? prefix].every((id) => id.startsWith(prefix))) return false;
					budget.used++;
					return true;
				}).map((span) => ({ ...span, attributes: { ...span.attributes, ...stamp } }));
				const written = options.target.ingest({ spans: own, metrics: [] });
				return { written, dropped: spans.length - written };
			} } };
		}, { untraced: true });
		host.serve(WorkerTelemetry, (_params, principal) => {
			const address = options.workerHost(principal);
			if (address === undefined) return { variant: "other", members: {} };
			return { variant: "worker", members: { ingest: async ({ spans, metrics }) => {
				const written = options.target.ingest({ metrics, spans: spans.map((span) => ({ ...span, attributes: { ...span.attributes, "objects.host": address } })) });
				return { written, dropped: spans.length - written };
			} } };
		}, { untraced: true });
	});
}
