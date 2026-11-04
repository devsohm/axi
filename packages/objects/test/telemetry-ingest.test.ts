import { expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import { createHost, hostKind, memoryLinkPair } from "../src/index.ts";
import { sendPageTelemetry, TelemetryRecorder, telemetryIngestFacet, type TelemetryBatch } from "../src/telemetry-ingest/index.ts";

it("retains disconnected page spans, stamps the authenticated sender and never sends page metrics", async () => {
	const batches: TelemetryBatch[] = [];
	const server = createHost({ address: hostKind("server")(), principal: { kind: "server" }, onError: (error) => { throw error; } });
	await server.load([{ name: "telemetry", facet: telemetryIngestFacet({
		target: { ingest(batch) { batches.push(batch); return batch.spans.length; } },
		workerHost: () => undefined,
		principalAttributes: (principal) => ({ "identity.kind": principal.kind }),
	}) }], context);
	let incarnation = "";
	const recorder = new TelemetryRecorder(() => `browser:${incarnation}`, 100);
	const client = createHost({ telemetry: recorder, onError: (error) => { throw error; } });
	incarnation = client.incarnation;
	await client.load([], context);
	const sender = sendPageTelemetry(client, recorder, context);
	try {
		await recorder.startSpan({ name: "clicked", attributes: { "objects.host": "forged" } }, () => {});
		recorder.metrics.counter("private-count").add(3);
		await sender.send(true);
		expect(batches).toEqual([]);
		const [a, b] = memoryLinkPair();
		server.accept(a, { principal: { kind: "visitor" } }, context);
		client.connect(b, { principal: { kind: "server" } }, context);
		for (let step = 0; step < 20 && batches.length === 0; step++) {
			await new Promise<void>((resolve) => setImmediate(resolve));
			await sender.send(true);
		}
		expect(batches).toHaveLength(1);
		expect(batches[0]!.metrics).toEqual([]);
		expect(batches[0]!.spans[0]).toMatchObject({ name: "clicked", attributes: { "objects.host": "browser", "identity.kind": "visitor" } });
		expect(recorder.queuedSpans).toBe(0);
	} finally { sender.stop(); await client.close(context); await server.close(context); }
});
