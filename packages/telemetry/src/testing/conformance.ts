import assert from "node:assert/strict";
import { NOOP_TELEMETRY_CONTEXT, type TelemetryCarrier, type TelemetryContext, type TelemetrySpan } from "../index.ts";
import type { RecordedTelemetrySpan } from "../memory.ts";
import type {
	TelemetryAdapterConformanceCase,
	TelemetryAdapterFixture,
	TelemetryAdapterFixtureFactory,
} from "./types.ts";

function named(spans: readonly RecordedTelemetrySpan[], name: string): RecordedTelemetrySpan {
	const span = spans.find((span) => span.name === name);
	assert(span, `Expected recorded span ${name}`);
	return span;
}
async function rejection(operation: Promise<unknown>, expected: unknown): Promise<void> {
	await operation.then(
		() => assert.fail("Expected operation to reject"),
		(error) => assert.equal(error, expected),
	);
}
export function createTelemetryAdapterConformance(
	factory: TelemetryAdapterFixtureFactory,
): readonly TelemetryAdapterConformanceCase[] {
	function check(
		group: string,
		name: string,
		run: (fixture: TelemetryAdapterFixture) => Promise<void>,
	): TelemetryAdapterConformanceCase {
		return {
			group,
			name,
			async run() {
				await using fixture = await factory();
				await run(fixture);
			},
		};
	}
	return [
		check("capabilities", "carries adapter capabilities through contexts and spans", async (fixture) => {
			const metrics = fixture.metrics ?? fixture.context.metrics;
			const propagation = fixture.propagation ?? fixture.context.propagation;
			const inspect = (context: TelemetryContext): void => {
				assert.equal(context.metrics, metrics);
				assert.equal(context.propagation, propagation);
			};
			inspect(fixture.context);
			let saved: TelemetrySpan | undefined;
			await fixture.context.startSpan({ name: "capabilities" }, async (span) => {
				saved = span;
				inspect(span);
				await span.startSpan({ name: "capabilities.child" }, inspect);
				if (propagation) {
					const restored = propagation.extract(propagation.inject(span));
					inspect(restored);
					await restored.startSpan({ name: "capabilities.extracted" }, inspect);
				}
			});
			assert(saved);
			await saved.startSpan({ name: "capabilities.inert" }, inspect);
		}),
		check("metrics", "records ordered measurements and optional histogram exemplars", async (fixture) => {
			if (!fixture.metrics) return;
			assert(fixture.getMetrics, "Metrics fixtures require a normalized measurement reader");
			fixture.metrics.counter("bytes", { description: "Encoded bytes", unit: "By" }).add(12, { direction: "out" });
			const active = fixture.metrics.upDownCounter("active");
			active.add(1);
			active.add(-1);
			const histogram = fixture.metrics.histogram("duration", { unit: "ms", boundaries: [1, 10] });
			await fixture.context.startSpan({ name: "measured" }, (span) => histogram.record(5, { method: "read" }, span));
			const measurements = await fixture.getMetrics();
			assert.deepEqual(
				measurements.map((item) => [item.kind, item.name, item.value]),
				[
					["counter", "bytes", 12],
					["upDownCounter", "active", 1],
					["upDownCounter", "active", -1],
					["histogram", "duration", 5],
				],
			);
			assert.deepEqual(measurements[0]?.attributes, { direction: "out" });
			assert.equal(measurements[0]?.description, "Encoded bytes");
			assert.equal(measurements[0]?.unit, "By");
			assert.deepEqual(measurements[3]?.boundaries, [1, 10]);
			assert.deepEqual(measurements[3]?.context, named(await fixture.getSpans(), "measured").context);
		}),
		check("metrics", "copies instrument metadata and measurement attributes", async (fixture) => {
			if (!fixture.metrics) return;
			assert(fixture.getMetrics, "Metrics fixtures require a normalized measurement reader");
			const boundaries = [1, 10];
			const options = { description: "Original", boundaries };
			const histogram = fixture.metrics.histogram("snapshot", options);
			boundaries.push(100);
			options.description = "Changed";
			const attributes = { tags: ["original"] };
			histogram.record(-1, attributes);
			attributes.tags.push("changed");
			const measurements = await fixture.getMetrics();
			assert.equal(measurements.length, 1);
			assert.deepEqual(measurements[0]?.attributes, { tags: ["original"] });
			assert.deepEqual(measurements[0]?.boundaries, [1, 10]);
			assert.equal(measurements[0]?.description, "Original");
			assert.equal(measurements[0]?.context, null);
		}),
		check("links", "records initial and late links without changing parents", async (fixture) => {
			let target: TelemetrySpan | undefined;
			await fixture.context.startSpan({ name: "target" }, (span) => {
				target = span;
			});
			if (!target) throw new Error("Expected target span");
			const settled = target;
			const attributes = { reason: ["initial"] };
			await fixture.context.startSpan({ name: "linked", links: [{ context: target, attributes }] }, (span) => {
				attributes.reason.push("mutated");
				span.addLink({ context: settled, attributes: { reason: "late" } });
				span.addLink({ context: NOOP_TELEMETRY_CONTEXT });
			});
			const spans = await fixture.getSpans();
			const linked = named(spans, "linked");
			assert.equal(linked.parentId, null);
			assert.equal(linked.parentContext, null);
			assert.deepEqual(linked.links, [
				{ context: named(spans, "target").context, attributes: { reason: ["initial"] } },
				{ context: named(spans, "target").context, attributes: { reason: "late" } },
			]);
		}),
		check("links", "ignores links added after source settlement", async (fixture) => {
			let saved: TelemetrySpan | undefined;
			await fixture.context.startSpan({ name: "link-source" }, (span) => {
				saved = span;
			});
			assert(saved);
			saved.addLink({ context: saved });
			assert.deepEqual(named(await fixture.getSpans(), "link-source").links, []);
		}),
		check("propagation", "roundtrips parent identity through JSON without retaining the carrier", async (fixture) => {
			if (!fixture.propagation) return;
			const propagation = fixture.propagation;
			await fixture.context.startSpan({ name: "sender" }, async (span) => {
				const carrier = propagation.inject(span);
				assert(carrier);
				const wire: TelemetryCarrier = JSON.parse(JSON.stringify(carrier));
				const parent = propagation.extract(wire);
				for (const key of Object.keys(wire)) wire[key] = "mutated";
				await parent.startSpan({ name: "receiver" }, () => 42);
				assert.deepEqual(propagation.inject(span), carrier);
			});
			const spans = await fixture.getSpans();
			assert.deepEqual(named(spans, "receiver").parentContext, named(spans, "sender").context);
		}),
		check("propagation", "absent and unknown carriers produce recorded roots", async (fixture) => {
			if (!fixture.propagation) return;
			assert.equal(fixture.propagation.inject(NOOP_TELEMETRY_CONTEXT), undefined);
			const carriers: (TelemetryCarrier | undefined)[] = [undefined, {}, { unknown: "format" }];
			for (const [index, carrier] of carriers.entries()) {
				const context = fixture.propagation.extract(carrier);
				assert.equal(await context.startSpan({ name: "fallback-" + index }, () => 42), 42);
			}
			for (const span of await fixture.getSpans()) assert.equal(span.parentContext, null);
		}),
		check("propagation", "propagates across fresh adapters and multiple hops", async (fixture) => {
			if (!fixture.propagation) return;
			await using receiver = await factory();
			await using worker = await factory();
			if (!receiver.propagation || !worker.propagation) throw new Error("Expected propagation on each fixture");
			let senderCarrier: TelemetryCarrier | undefined;
			await fixture.context.startSpan({ name: "sender" }, (span) => {
				senderCarrier = fixture.propagation?.inject(span);
			});
			assert(senderCarrier);
			let receiverCarrier: TelemetryCarrier | undefined;
			await receiver.propagation
				.extract(JSON.parse(JSON.stringify(senderCarrier)))
				.startSpan({ name: "receiver" }, (span) => {
					receiverCarrier = receiver.propagation?.inject(span);
				});
			assert(receiverCarrier);
			await worker.propagation
				.extract(JSON.parse(JSON.stringify(receiverCarrier)))
				.startSpan({ name: "worker" }, () => {});
			assert.deepEqual(named(await receiver.getSpans(), "receiver").parentContext, senderCarrier);
			assert.deepEqual(named(await worker.getSpans(), "worker").parentContext, receiverCarrier);
		}),
		check("callback lifecycle", "admits once synchronously and preserves the result", async (fixture) => {
			let calls = 0;
			const value = { value: 42 };
			const pending = fixture.context.startSpan({ name: "success" }, () => {
				calls++;
				return value;
			});
			assert.equal(calls, 1);
			assert.equal(await pending, value);
			assert.deepEqual(named(await fixture.getSpans(), "success").status, { status: "ok" });
			assert.equal(named(await fixture.getSpans(), "success").settled, true);
		}),
		check("callback lifecycle", "preserves synchronous and asynchronous rejection values", async (fixture) => {
			const values: unknown[] = [new Error("sync"), { kind: "async" }, undefined];
			const names = ["sync-error", "async-error", "undefined-error"];
			for (const [id, value] of values.entries()) {
				const callback =
					id === 1
						? async () => {
								throw value;
							}
						: () => {
								if (id === 0) throw value;
								return Promise.reject(value);
							};
				const pending = fixture.context.startSpan({ name: names[id] }, callback);
				await rejection(pending, value);
			}
			const spans = await fixture.getSpans();
			for (const name of names) assert.equal(named(spans, name).status.status, "error");
		}),
		check("status", "uses last explicit status without automatic overwrite", async (fixture) => {
			await fixture.context.startSpan({ name: "last-status" }, (span) => {
				span.setStatus({ status: "error", error: { name: "Expected", message: "first" } });
				span.setStatus({ status: "ok" });
			});
			const error = new Error("after explicit status");
			await rejection(
				fixture.context.startSpan({ name: "explicit-before-throw" }, (span) => {
					span.setStatus({ status: "ok" });
					throw error;
				}),
				error,
			);
			const asyncError = new Error("after async explicit status");
			await rejection(
				fixture.context.startSpan({ name: "explicit-before-rejection" }, (span) => {
					span.setStatus({ status: "error", error: { name: "Expected", message: "async failure" } });
					return Promise.reject(asyncError);
				}),
				asyncError,
			);
			await fixture.context.startSpan({ name: "expected-failure" }, (span) => {
				span.setStatus({ status: "error", error: { name: "Expected", message: "returned failure" } });
				return { ok: false };
			});
			const spans = await fixture.getSpans();
			assert.deepEqual(named(spans, "last-status").status, { status: "ok" });
			assert.deepEqual(named(spans, "explicit-before-throw").status, { status: "ok" });
			assert.deepEqual(named(spans, "explicit-before-rejection").status, {
				status: "error",
				error: { name: "Expected", message: "async failure" },
			});
			assert.deepEqual(named(spans, "expected-failure").status, {
				status: "error",
				error: { name: "Expected", message: "returned failure" },
			});
		}),
		check("recording", "merges attributes and records ordered events", async (fixture) => {
			await fixture.context.startSpan(
				{ name: "recording", attributes: { start: "value", overwrite: "start", ignored: undefined } },
				(span) => {
					span.setAttributes({ count: 1, overwrite: "middle" });
					span.setAttributes({ count: undefined, overwrite: "end" });
					span.addEvent("first", { index: 1, ignored: undefined });
					span.addEvent("second", { index: 2 });
				},
			);
			const span = named(await fixture.getSpans(), "recording");
			assert.deepEqual(span.attributes, { start: "value", overwrite: "end", count: 1 });
			assert.deepEqual(span.events, [
				{ name: "first", attributes: { index: 1 } },
				{ name: "second", attributes: { index: 2 } },
			]);
		}),

		check("recording", "makes calls after settlement inert", async (fixture) => {
			let captured: TelemetrySpan | undefined;
			await fixture.context.startSpan({ name: "settled", attributes: { value: "initial" } }, (span) => {
				captured = span;
			});
			assert(captured);
			captured.setAttributes({ value: "late" });
			captured.addEvent("late", { value: true });
			captured.setStatus({ status: "error" });
			let called = false;
			const child = captured.startSpan({ name: "late-child" }, () => {
				called = true;
				return 7;
			});
			assert.equal(called, true);
			assert.equal(await child, 7);
			const spans = await fixture.getSpans();
			assert.equal(spans.length, 1);
			assert.deepEqual(spans[0].attributes, { value: "initial" });
			assert.deepEqual(spans[0].events, []);
			assert.deepEqual(spans[0].status, { status: "ok" });
		}),
		check("parentage", "records nested and concurrent child relationships", async (fixture) => {
			let release: (() => void) | undefined;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			await fixture.context.startSpan({ name: "parent" }, async (span) => {
				const first = span.startSpan({ name: "first-child" }, async () => {
					await gate;
				});
				assert.equal(await span.startSpan({ name: "second-child" }, () => "done"), "done");
				release?.();
				await first;
			});
			const spans = await fixture.getSpans(),
				parent = named(spans, "parent"),
				first = named(spans, "first-child"),
				second = named(spans, "second-child");
			assert.equal(parent.parentId, null);
			assert.equal(first.parentId, parent.id);
			assert.equal(second.parentId, parent.id);
			assert(second.endSequence !== undefined && first.endSequence !== undefined && parent.endSequence !== undefined);
			assert(second.endSequence < first.endSequence && first.endSequence < parent.endSequence);
		}),
	];
}
