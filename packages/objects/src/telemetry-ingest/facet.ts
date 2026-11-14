import type { SpanAttributes, StoredSpan } from "@axi/telemetry";
import { forbidden, type Principal } from "../data/index.ts";
import { defineFacet, type Facet } from "../host/index.ts";
import { PageTelemetry, WorkerTelemetry } from "./batch.ts";
import type { TelemetryBatch } from "./recorder.ts";

export const PAGE_SPANS_PER_MINUTE = 1200;
export type TelemetryIngestTarget = { ingest(batch: TelemetryBatch): number };
export type TelemetryIngestOptions<P extends Principal> = {
	readonly target: TelemetryIngestTarget;
	readonly admit: (principal: P) => boolean;
	readonly workerHost: (principal: P) => string | undefined;
	readonly principalAttributes: (principal: P) => Readonly<SpanAttributes>;
};

export function telemetryIngestFacet<P extends Principal>(options: TelemetryIngestOptions<P>): Facet<P> {
	return defineFacet<P>((host) => {
		host.serve(
			PageTelemetry,
			(_params, principal) => {
				if (!options.admit(principal)) throw forbidden("objects.telemetry.page: not admitted");
				const minutes = new Map<string, { since: number; used: number }>();
				return {
					variant: "main",
					members: {
						ingest: async ({ spans }, ctx) => {
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
							const own: StoredSpan[] = [];
							for (const span of spans) {
								if (budget.used >= PAGE_SPANS_PER_MINUTE) break;
								if (span.endedMs < span.startedMs) continue;
								if (![span.id, span.traceId, span.parentId ?? prefix].every((id) => id.startsWith(prefix))) continue;
								// Stamp this span before charging the next; the callback can fail.
								budget.used++;
								own.push({
									...span,
									attributes: {
										"objects.host": "browser",
										...Object.fromEntries(
											Object.entries(span.attributes).filter(([name]) => !name.startsWith("objects.")),
										),
										...options.principalAttributes(principal),
									},
								});
							}
							const written = options.target.ingest({ spans: own, metrics: [] });
							return { written, dropped: spans.length - written };
						},
					},
				};
			},
			{ untraced: true },
		);
		host.serve(
			WorkerTelemetry,
			(_params, principal) => {
				const address = options.workerHost(principal);
				if (address === undefined) return { variant: "other", members: {} };
				return {
					variant: "worker",
					members: {
						ingest: async ({ spans, metrics }) => {
							const written = options.target.ingest({
								metrics,
								spans: spans.map((span) => ({ ...span, attributes: { ...span.attributes, "objects.host": address } })),
							});
							return { written, dropped: spans.length - written };
						},
					},
				};
			},
			{ untraced: true },
		);
	});
}
