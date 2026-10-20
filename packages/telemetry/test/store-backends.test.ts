import { afterEach, expect, test, vi } from "vitest";
import { openNodeSqliteDatabase } from "@axi/chord/sqlite/node";
import { createSqliteTelemetry } from "@axi/chord/telemetry-sqlite";
import { InMemoryTelemetryContext, type TelemetryContext, type TelemetryStore } from "../src/index.ts";

afterEach(() => vi.restoreAllMocks());
async function fixture(backend: "memory" | "sqlite") {
	if (backend === "memory") {
		const recorder = new InMemoryTelemetryContext();
		return { context: recorder, store: recorder, propagation: recorder, async flush() {}, async close() {} };
	}
	const db = await openNodeSqliteDatabase(":memory:");
	const recorder = await createSqliteTelemetry(db);
	return {
		context: recorder,
		store: recorder,
		propagation: recorder.propagation,
		flush: () => recorder.flush(),
		async close() {
			try {
				await recorder.close();
			} finally {
				await db.close();
			}
		},
	};
}
for (const backend of ["memory", "sqlite"] as const) {
	test(`${backend} trace pages retain whole traces with tied timestamps and detached snapshots`, async () => {
		const now = vi.spyOn(Date, "now").mockReturnValue(10000);
		const f = await fixture(backend);
		try {
			for (let i = 0; i < 7; i++) {
				now.mockReturnValue(10000);
				await f.context.startSpan({ name: "request", attributes: { index: i } }, async (parent) => {
					parent.addEvent("sent", { labels: ["initial"] });
					now.mockReturnValue(10001);
					await parent.startSpan({ name: "parse" }, () => {});
				});
			}
			await f.flush();
			const all = await f.store.findTraces({ limit: 100 });
			expect(all.traces.map((trace) => trace.spans.map((span) => span.name))).toEqual(
				Array.from({ length: 7 }, () => ["request", "parse"]),
			);
			const ids: string[] = [];
			let cursor: string | undefined;
			do {
				const page = await f.store.findTraces({ limit: 2, cursor });
				ids.push(...page.traces.map((trace) => trace.traceId));
				cursor = page.cursor;
			} while (cursor);
			expect(ids).toEqual(all.traces.map((trace) => trace.traceId));
			expect(new Set(ids).size).toBe(7);
			const first = all.traces[0]!;
			first.spans[0]!.attributes.index = -1;
			first.spans[0]!.events[0]!.attributes.labels = ["edited"];
			expect((await f.store.getTrace(first.traceId))?.spans[0]?.attributes.index).not.toBe(-1);
			expect((await f.store.getTrace(first.traceId))?.spans[0]?.events[0]?.attributes.labels).toEqual(["initial"]);
		} finally {
			await f.close();
		}
	});

	test(`${backend} store requires a complete trace and matches typed attributes on the same span`, async () => {
		const now = vi.spyOn(Date, "now").mockReturnValue(10000);
		const f = await fixture(backend);
		const gate = Promise.withResolvers<void>();
		const active = f.context.startSpan({ name: "pending" }, () => gate.promise);
		try {
			await f.flush();
			expect((await f.store.findTraces()).traces).toEqual([]);
			gate.resolve();
			await active;
			await f.context.startSpan({ name: "split" }, async (root) => {
				await root.startSpan({ name: "left", attributes: { a: true } }, () => {});
				await root.startSpan({ name: "right", attributes: { b: 2 } }, () => {});
			});
			now.mockReturnValue(20000);
			await f.context.startSpan({ name: "matched" }, async (root) => {
				await root.startSpan({ name: "child", attributes: { a: true, b: 2 } }, (span) =>
					span.setStatus({ status: "error" }),
				);
			});
			await f.flush();
			const names = async (query: Parameters<TelemetryStore["findTraces"]>[0]) =>
				(await f.store.findTraces(query)).traces.map((trace) => trace.spans[0]?.name);
			expect(await names({ attributes: { a: true, b: 2 } })).toEqual(["matched"]);
			expect(await names({ attributes: { a: 1 } })).toEqual([]);
			expect(await names({ errors: true, startMin: 20000, startMax: 20000 })).toEqual(["matched"]);
			expect(await names({ name: "child" })).toEqual([]);
		} finally {
			gate.resolve();
			await active;
			await f.close();
		}
	});

	test(`${backend} propagation continues across recorders without turning links into parents`, async () => {
		const sender = await fixture(backend),
			receiver = await fixture(backend);
		try {
			let remote: TelemetryContext | undefined;
			await sender.context.startSpan({ name: "sender" }, (span) => {
				const wire = JSON.parse(JSON.stringify(sender.propagation.inject(span)));
				remote = receiver.propagation.extract(wire);
			});
			if (!remote) throw new Error("Missing remote context");
			await remote.startSpan({ name: "receiver" }, () => {});
			await receiver.context.startSpan(
				{ name: "linked", links: [{ context: remote, attributes: { why: "work" } }] },
				() => {},
			);
			await sender.flush();
			await receiver.flush();
			const sent = (await sender.store.findTraces()).traces[0]!;
			expect((await receiver.store.getTrace(sent.traceId))?.spans.map((span) => [span.name, span.parentId])).toEqual([
				["receiver", sent.spans[0]!.id],
			]);
			const linked = (await receiver.store.findTraces({ name: "linked" })).traces[0]!;
			expect(linked.spans[0]!.parentId).toBeUndefined();
			expect(linked.spans[0]!.links).toEqual([
				{ traceId: sent.traceId, spanId: sent.spans[0]!.id, attributes: { why: "work" } },
			]);
		} finally {
			await sender.close();
			await receiver.close();
		}
	});
}
