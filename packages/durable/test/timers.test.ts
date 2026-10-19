import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@axi/chord/context";
import { describe, expect, it, vi } from "vitest";
import {
	defineDoc,
	MemoryStorage,
	ROOT_CONVERSATION_ID,
	type SetTimer,
	type TaskId,
	type TaskRecord,
} from "../src/index.ts";
import { SessionImpl } from "../src/session/session.ts";
import { openNodeJsonlStorage } from "../src/storage/jsonl/node.ts";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { hostTimers, nativeTimer } from "../src/timers.ts";

describe("host timers", () => {
	it("falls back for declined foreground work and reports the failure once", async () => {
		vi.useFakeTimers();
		try {
			const errors: unknown[] = [];
			const timers = hostTimers(
				() => undefined,
				(error) => errors.push(error),
			);
			const calls: string[] = [];
			timers.foreground(() => calls.push("first"), 10);
			timers.foreground(() => calls.push("second"), 20);
			expect(timers.background(() => calls.push("unused"), 0)).toBeUndefined();
			await vi.advanceTimersByTimeAsync(20);
			expect(calls).toEqual(["first", "second"]);
			expect(errors).toHaveLength(1);
			expect(errors[0]).toBeInstanceOf(Error);
		} finally {
			vi.useRealTimers();
		}
	});
	it("cancels a long native timer after its first bounded step", async () => {
		vi.useFakeTimers();
		try {
			let called = false;
			const cancel = nativeTimer(
				() => {
					called = true;
				},
				2_147_483_647 + 50,
				{ background: false },
			);
			await vi.advanceTimersByTimeAsync(2_147_483_647);
			expect(called).toBe(false);
			cancel?.();
			await vi.advanceTimersByTimeAsync(50);
			expect(called).toBe(false);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});
	it("rechecks document retention when an injected timer fires early", async () => {
		let now = 1_000;
		const timers: { callback: () => void; delay: number; background: boolean; cancelled: boolean }[] = [];
		const setTimer: SetTimer = (callback, delay, options) => {
			const timer = { callback, delay, background: options.background, cancelled: false };
			timers.push(timer);
			return () => {
				timer.cancelled = true;
			};
		};
		const State = defineDoc({ kind: "state", scope: "session", version: 1, initial: () => ({ count: 0 }) });
		const session = new SessionImpl(
			new MemoryStorage(),
			() => now,
			() => 100,
			setTimer,
		);
		try {
			await session.commit(async (tx) => {
				(await tx.doc(State)).count = 1;
			}, context);
			expect(timers.map((timer) => [timer.delay, timer.background])).toEqual([[100, true]]);
			now = 1_050;
			timers[0].callback();
			await session.readOnLine(async () => {});
			expect(session.documentCacheSizes.cached).toBe(1);
			expect(timers.map((timer) => timer.delay)).toEqual([100, 50]);
			now = 1_100;
			timers[1].callback();
			await session.readOnLine(async () => {});
			expect(session.documentCacheSizes.cached).toBe(0);
		} finally {
			await session.close(context);
		}
	});
});

describe.each(["sqlite", "jsonl"] as const)("%s sleeping checkpoints", (kind) => {
	it("restores the wake time, memo and restart count with its status index", async () => {
		const directory = await mkdtemp(join(tmpdir(), "axi-sleep-"));
		const open = () =>
			kind === "sqlite"
				? openNodeSqliteStorage(join(directory, "records.sqlite"), { prefix: "test_" })
				: openNodeJsonlStorage(join(directory, "records"), context, { fsync: true });
		let storage = await open();
		try {
			await storage.commit([{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], context);
			const id = await storage.mintId<TaskId<string>>();
			const task: TaskRecord<null, { phase: string }, string> = {
				id,
				conversationId: ROOT_CONVERSATION_ID,
				kind: "work",
				version: 1,
				input: null,
				background: false,
				abortRequested: false,
				restarts: 2,
				memos: { receipt: "saved" },
				state: { status: "sleeping", until: 61_000, checkpoint: { phase: "resume" } },
			};
			await storage.commit([{ type: "task", value: task }], context);
			await storage.close(context);
			storage = await open();
			expect(await storage.task(id, context)).toEqual(task);
			expect((await storage.scanTasks({ status: "sleeping" }, 10, undefined, context)).items).toEqual([task]);
			expect((await storage.scanTasks({ status: "running" }, 10, undefined, context)).items).toEqual([]);
		} finally {
			await storage.close(context);
			await rm(directory, { recursive: true, force: true });
		}
	});
});
