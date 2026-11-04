import { BACKGROUND_CONTEXT, type Context } from "../context/index.ts";
import type { Principal } from "../data/index.ts";
import type { Host } from "../host/index.ts";
import { PAGE_BATCH_SPANS, PageTelemetry, WORKER_BATCH_ROWS, WorkerTelemetry } from "./batch.ts";
import type { TelemetryBatch, TelemetryRecorder } from "./recorder.ts";

export type TelemetrySender = { send(partial: boolean): Promise<void>; stop(): void };

function queue(recorder: TelemetryRecorder, limit: number, pending: (partial: boolean) => boolean,
	release: () => void, deliver: (batch: TelemetryBatch) => Promise<unknown> | undefined): TelemetrySender {
	let tail = Promise.resolve(), stopped = false;
	return {
		send(partial) {
			if (stopped) return Promise.resolve();
			tail = tail.then(async () => {
				if (!pending(partial)) return;
				const batch = recorder.take(partial, limit);
				const sent = deliver(batch);
				if (sent === undefined) {
					recorder.release();
					recorder.ingest(batch);
					return;
				}
				try { await sent; } catch {} finally { recorder.release(); }
			});
			return tail;
		},
		stop() { stopped = true; release(); },
	};
}

export function sendPageTelemetry<P extends Principal>(host: Host<P>, recorder: TelemetryRecorder, context: Context): TelemetrySender {
	const held = host.hold(PageTelemetry, {}, context);
	return queue(recorder, PAGE_BATCH_SPANS, () => recorder.queuedSpans > 0, () => held.release(), (batch) =>
		held.state.value.kind === "live" ? held.ingest({ spans: batch.spans }, BACKGROUND_CONTEXT) : undefined);
}
export function sendWorkerTelemetry<P extends Principal>(host: Host<P>, recorder: TelemetryRecorder, context: Context): TelemetrySender {
	const held = host.hold(WorkerTelemetry, {}, context);
	return queue(recorder, WORKER_BATCH_ROWS, (partial) => recorder.pending(partial), () => held.release(), (batch) =>
		held.state.value.kind === "live" && held.variant === "worker"
			? held.ingest({ spans: batch.spans, metrics: batch.metrics.slice(0, WORKER_BATCH_ROWS) }, BACKGROUND_CONTEXT) : undefined);
}
