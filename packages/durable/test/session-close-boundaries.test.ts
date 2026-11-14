import { BACKGROUND_CONTEXT as context } from "@axi/objects/context";
import { expect, test } from "vitest";
import { defineDoc, MemoryStorage, type ReportInfo } from "../src/index.ts";
import { SessionImpl } from "../src/session/session.ts";

const Counter = defineDoc({
	kind: "close-counter",
	version: 1,
	scope: "session",
	initial: () => ({ count: 0 }),
	checkpointWhen: () => false,
});
class ReportingSession extends SessionImpl {
	readonly reports: { error: unknown; info: ReportInfo }[] = [];
	override report(error: unknown, info: ReportInfo = { kind: "listener_error" }): void {
		this.reports.push({ error, info });
	}
}

test("a throwing close subscriber is contained while later subscribers and backend cleanup finish", async () => {
	const failure = new Error("Subscriber failed"),
		storage = new MemoryStorage(),
		session = new ReportingSession(storage);
	const seen: string[] = [];
	session.subscribeClose(() => {
		seen.push("first");
		throw failure;
	});
	session.subscribeClose(() => seen.push("second"));
	const detached = session.subscribeClose(() => seen.push("detached"));
	detached();
	await session.commit((tx) => tx.doc(Counter), context);
	await session.close(context);
	await session.close(context);
	expect(seen).toEqual(["first", "second"]);
	expect(session.reports).toEqual([{ error: failure, info: { kind: "listener_error" } }]);
	expect(await session.closed).toEqual({ kind: "closed" });
	expect(session.documentCacheSizes).toMatchObject({ cached: 0, attached: 0 });
	await expect(session.snapshot(Counter, context)).rejects.toThrow("Session is closed");
});

test("a failed backend close is reported once and subsequent close calls retain that failure", async () => {
	const failure = new Error("Backend close failed");
	class Storage extends MemoryStorage {
		closes = 0;
		override async close(ctx: Parameters<MemoryStorage["close"]>[0]) {
			this.closes++;
			await super.close(ctx);
			throw failure;
		}
	}
	const storage = new Storage(),
		session = new ReportingSession(storage);
	await session.commit((tx) => tx.doc(Counter), context);
	await expect(session.close(context)).rejects.toBe(failure);
	await expect(session.close(context)).rejects.toBe(failure);
	expect(storage.closes).toBe(1);
	expect(await session.closed).toEqual({ kind: "failed", error: failure });
	expect(session.reports).toEqual([{ error: failure, info: { kind: "storage_failed" } }]);
	await expect(session.snapshot(Counter, context)).rejects.toMatchObject({ name: "SessionFailed", cause: failure });
});

test("a throwing background timer leaves committed documents available without repeated timer attempts", async () => {
	const failure = new Error("Background timers unavailable");
	let now = 0,
		attempts = 0;
	const session = new ReportingSession(
		new MemoryStorage(),
		() => now,
		() => 1,
		() => {
			attempts++;
			throw failure;
		},
	);
	try {
		await session.commit((tx) => tx.doc(Counter), context);
		now = 100;
		await session.commit(async (tx) => {
			(await tx.doc(Counter)).count = 2;
		}, context);
		expect(await session.snapshot(Counter, context)).toEqual({ count: 2 });
		expect(attempts).toBe(1);
		expect(session.reports).toEqual([{ error: failure, info: { kind: "host_error", callback: "setTimer" } }]);
	} finally {
		await session.close(context);
	}
});
