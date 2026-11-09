import { expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import { createHost, hostKind, memoryLinkPair } from "../src/index.ts";
import { sendPageTelemetry, TelemetryRecorder, telemetryIngestFacet, type TelemetryBatch } from "../src/telemetry-ingest/index.ts";

it("ignores measurements and their attributes after recording stops", () => {
	let reads = 0;
	const attributes = { get value() { reads++; return 1; } };
	for (const mode of ["keep", "discard"] as const) {
		const recorder = new TelemetryRecorder(() => "test", 10);
		const instruments = [
			recorder.metrics.counter("count"),
			recorder.metrics.upDownCounter("active"),
			recorder.metrics.histogram("latency"),
		];
		recorder.stop(mode);
		for (const instrument of instruments) {
			if ("record" in instrument) instrument.record(1, attributes);
			else instrument.add(1, attributes);
		}
		expect(recorder.take(true)).toEqual({ spans: [], metrics: [] });
	}
	expect(reads).toBe(0);
});

it("retains disconnected page spans, stamps the authenticated sender and never sends page metrics", async () => {
	const batches: TelemetryBatch[] = [];
	let principalReads = 0;
	const server = createHost({ address: hostKind("server")(), principal: { kind: "server" }, onError: (error) => { throw error; } });
	await server.load([{ name: "telemetry", facet: telemetryIngestFacet({
		target: { ingest(batch) { batches.push(batch); return batch.spans.length; } },
		workerHost: () => undefined,
		principalAttributes: (principal) => { principalReads++; return { "identity.kind": principal.kind }; },
	}) }], context);
	let incarnation = "";
	const recorder = new TelemetryRecorder(() => `browser:${incarnation}`, 100);
	const client = createHost({ telemetry: recorder, onError: (error) => { throw error; } });
	incarnation = client.incarnation;
	await client.load([], context);
	const sender = sendPageTelemetry(client, recorder, context);
	try {
		await recorder.startSpan({ name: "clicked", attributes: { "objects.host": "forged", "objects.principal": "forged" } }, () => {});
		await recorder.startSpan({ name: "clicked again", attributes: { "app.color": "blue" } }, () => {});
		recorder.metrics.counter("private-count").add(3);
		await sender.send(true);
		expect(batches).toEqual([]);
		expect(principalReads).toBe(0);
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
		expect(batches[0]!.spans[0]!.attributes).not.toHaveProperty("objects.principal");
		expect(batches[0]!.spans[1]!.attributes).toHaveProperty("app.color", "blue");
		expect(principalReads).toBe(2);
		expect(recorder.queuedSpans).toBe(0);
	} finally { sender.stop(); await client.close(context); await server.close(context); }
});
