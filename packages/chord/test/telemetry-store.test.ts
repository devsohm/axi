import { expect, test, vi } from "vitest";
import { openNodeSqliteDatabase } from "../src/sqlite/node.ts";
import { createSqliteTelemetry } from "../src/telemetry-sqlite/index.ts";

test("SQLite propagation surfaces carrier errors and delegates cursor values to SQL", async () => {
	const db = await openNodeSqliteDatabase(":memory:");
	const recorder = await createSqliteTelemetry(db);
	try {
		const problem = new Error("unreadable carrier");
		const carrier = new Proxy<Record<string, string>>(
			{},
			{
				get() {
					throw problem;
				},
			},
		);
		expect(() => recorder.propagation.extract(carrier)).toThrow(problem);
		await recorder.startSpan({ name: "request" }, () => {});
		await recorder.close();
		expect((await recorder.findTraces({ cursor: '["0", ""]' })).traces.map((trace) => trace.spans[0]?.name)).toEqual([
			"request",
		]);
	} finally {
		await recorder.close();
		await db.close();
	}
});

test("one flush uses one completed-interval cutoff even when the clock crosses a boundary", async () => {
	const db = await openNodeSqliteDatabase(":memory:");
	const recorder = await createSqliteTelemetry(db);
	let now = 10_000;
	const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
	try {
		const counter = recorder.metrics.counter("jobs");
		counter.add(2);
		now = 20_000;
		counter.add(3);
		clock.mockImplementation(() => {
			const observed = now;
			now = 30_000;
			return observed;
		});
		await recorder.flush();
		expect((await recorder.findMetrics({ name: "jobs" })).map((row) => [row.intervalMs, row.sum])).toEqual([
			[10_000, 2],
		]);
		await recorder.close();
		expect((await recorder.findMetrics({ name: "jobs" })).map((row) => [row.intervalMs, row.sum])).toEqual([
			[10_000, 2],
			[20_000, 3],
		]);
	} finally {
		clock.mockRestore();
		await recorder.close();
		await db.close();
	}
});

test("SQLite telemetry stores settled traces and drains partial metric intervals on close", async () => {
	const db = await openNodeSqliteDatabase(":memory:");
	const recorder = await createSqliteTelemetry(db);
	try {
		await recorder.startSpan({ name: "request" }, async (root) => {
			root.addEvent("accepted", { count: 1 });
			await root.startSpan({ name: "tool" }, (span) => span.setStatus({ status: "error" }));
		});
		recorder.metrics.counter("calls").add(2, { method: "read" });
		recorder.metrics.counter("calls").add(3, { method: "read" });
		expect((await recorder.findTraces()).traces).toEqual([]);
		await recorder.close();
		const result = await recorder.findTraces({ errors: true });
		expect(result.traces).toHaveLength(1);
		expect(result.traces[0]?.spans.map((span) => span.name)).toEqual(["request", "tool"]);
		expect(result.traces[0]?.spans[1]?.parentId).toBe(result.traces[0]?.spans[0]?.id);
		expect((await recorder.findMetrics({ name: "calls" })).map((row) => [row.count, row.sum])).toEqual([[2, 5]]);
		const reopened = await createSqliteTelemetry(db);
		try {
			expect(await reopened.getTrace(result.traces[0]!.traceId)).toEqual(result.traces[0]);
		} finally {
			await reopened.close();
		}
	} finally {
		await recorder.close();
		await db.close();
	}
});
