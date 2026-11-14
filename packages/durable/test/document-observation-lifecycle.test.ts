import { BACKGROUND_CONTEXT as context, withAbortSignal } from "@axi/objects/context";
import type { WatchCall, WatchEnd } from "@axi/objects/watch";
import { afterEach, expect, test, vi } from "vitest";
import { createSession, defineDoc, defineTask, MemoryStorage } from "../src/index.ts";
import { SessionImpl } from "../src/session/session.ts";
import { closeSchedulers, open, root } from "./scheduler-support.ts";

const Counter = defineDoc({
	kind: "observation-counter",
	version: 1,
	scope: "session",
	initial: () => ({ count: 0 }),
	checkpointWhen: () => false,
});
afterEach(closeSchedulers);

for (const method of ["watch", "observe"] as const) {
	test(`${method} cancellation after registration discards the attachment before returning`, async () => {
		const controller = new AbortController(),
			failure = new Error("Caller left during attachment");
		class Session extends SessionImpl {
			override subscribeClose(listener: () => void): () => void {
				const detach = super.subscribeClose(listener);
				controller.abort(failure);
				return detach;
			}
		}
		const session = new Session(new MemoryStorage()),
			listener = { advance: vi.fn(), end: vi.fn() };
		try {
			await session.commit((tx) => tx.doc(Counter), context);
			const invocation = withAbortSignal(controller.signal, context);
			await expect(
				method === "watch" ? session.watchDoc(Counter, invocation) : session.observeDoc(Counter, listener, invocation),
			).rejects.toBe(failure);
			expect(session.documentCacheSizes.attached).toBe(0);
			await session.commit(async (tx) => {
				(await tx.doc(Counter)).count = 5;
			}, context);
			expect(await session.snapshot(Counter, context)).toEqual({ count: 5 });
			expect(listener.advance).not.toHaveBeenCalled();
			expect(listener.end).not.toHaveBeenCalled();
		} finally {
			await session.close(context);
		}
	});

	test.each(["before-admission", "queued", "loading"] as const)(
		`${method} attachment cancelled %s leaves no observer behind`,
		async (stage) => {
			const entered = Promise.withResolvers<void>(),
				release = Promise.withResolvers<void>();
			class Storage extends MemoryStorage {
				hold = false;
				override async document(...args: Parameters<MemoryStorage["document"]>) {
					const value = await super.document(...args);
					if (this.hold) {
						entered.resolve();
						await release.promise;
					}
					return value;
				}
			}
			const storage = new Storage(),
				session = new SessionImpl(storage);
			const controller = new AbortController(),
				failure = new Error("Document caller cancelled");
			const listener = { advance: vi.fn(), end: vi.fn() };
			let blocker: Promise<void> | undefined;
			try {
				await session.commit((tx) => tx.doc(Counter), context);
				await session.unloadDocuments();
				if (stage === "before-admission") controller.abort(failure);
				if (stage === "queued") {
					blocker = session.commit(async () => {
						entered.resolve();
						await release.promise;
					}, context);
					await entered.promise;
				}
				storage.hold = stage === "loading";
				const invocation = withAbortSignal(controller.signal, context);
				const attached =
					method === "watch"
						? session.watchDoc(Counter, invocation)
						: session.observeDoc(Counter, listener, invocation);
				const rejected = expect(attached).rejects.toBe(failure);
				if (stage === "loading") await entered.promise;
				controller.abort(failure);
				release.resolve();
				await rejected;
				await blocker;
				storage.hold = false;
				await session.commit(async (tx) => {
					(await tx.doc(Counter)).count = 4;
				}, context);
				expect(await session.snapshot(Counter, context)).toEqual({ count: 4 });
				expect(session.documentCacheSizes.attached).toBe(0);
				expect(listener.advance).not.toHaveBeenCalled();
				expect(listener.end).not.toHaveBeenCalled();
			} finally {
				release.resolve();
				await blocker;
				await session.close(context);
			}
		},
	);
}

test("a live document watch releases its pin when its captured caller signal aborts", async () => {
	const session = new SessionImpl(new MemoryStorage()),
		controller = new AbortController();
	try {
		await session.commit((tx) => tx.doc(Counter), context);
		const watch = (await session.watchDoc(Counter, withAbortSignal(controller.signal, context)))!;
		const listener = vi.fn(async () => {});
		watch.start(listener);
		controller.abort();
		expect(await watch.closed).toEqual({ kind: "aborted" });
		expect(session.documentCacheSizes.attached).toBe(0);
		await session.commit(async (tx) => {
			(await tx.doc(Counter)).count++;
		}, context);
		expect(listener).not.toHaveBeenCalled();
	} finally {
		await session.close(context);
	}
});

test("observers follow retirement and a new incarnation at the same address", async () => {
	const session = createSession(new MemoryStorage());
	const seen: WatchCall<Readonly<{ count: number }>>[] = [],
		ends: WatchEnd[] = [];
	try {
		await session.commit(async (tx) => {
			(await tx.doc(Counter)).count = 7;
		}, context);
		const observation = (await session.observeDoc(
			Counter,
			{ advance: (call) => seen.push(call), end: (end) => ends.push(end) },
			context,
		))!;
		await session.commit((tx) => tx.retireDoc(Counter), context);
		expect(await session.snapshot(Counter, context)).toBeUndefined();
		await session.commit(async (tx) => {
			(await tx.doc(Counter)).count = 2;
		}, context);
		expect(seen).toEqual([
			{ kind: "value", value: { count: 7 }, ops: [], retired: true },
			{ kind: "value", value: { count: 2 }, ops: [["r", { count: 2 }]], retired: false },
		]);
		expect(observation.value).toEqual({ count: 7 });
		observation.detach();
		observation.detach();
		await session.commit(async (tx) => {
			(await tx.doc(Counter)).count = 3;
		}, context);
		expect(seen).toHaveLength(2);
		expect(ends).toEqual([]);
	} finally {
		await session.close(context);
	}
});

test("a definition upgrade replaces the observed value once before incremental updates resume", async () => {
	const next = defineDoc({
		...Counter.definition,
		version: 2,
		migrate: (value) => ({ count: Number(value.count) + 10 }),
	});
	const session = createSession(new MemoryStorage()),
		seen: WatchCall<Readonly<{ count: number }>>[] = [];
	try {
		await session.commit((tx) => tx.doc(Counter), context);
		const observation = (await session.observeDoc(Counter, { advance: (call) => seen.push(call), end() {} }, context))!;
		await session.commit(async (tx) => {
			(await tx.doc(next)).count++;
		}, context);
		await session.commit(async (tx) => {
			(await tx.doc(next)).count++;
		}, context);
		expect(seen).toMatchObject([
			{ kind: "value", value: { count: 11 }, ops: [["r", { count: 11 }]], retired: false },
			{ kind: "value", value: { count: 12 }, retired: false },
		]);
		expect(seen[1]?.kind === "value" && seen[1].ops[0]?.[0]).not.toBe("r");
		observation.detach();
	} finally {
		await session.close(context);
	}
});

test("task completion retires document observations and drains the watch before ending", async () => {
	const Progress = defineDoc({
		kind: "owned-progress",
		version: 1,
		scope: "task",
		initial: () => ({ count: 0 }),
		checkpointWhen: () => false,
	});
	const entered = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	const task = defineTask<null, { phase: "run" }, null>({
		name: "observed-owner",
		version: 1,
		initial: () => ({ phase: "run" }),
		phases: {
			async run(_record, runtime, ctx) {
				await runtime.commit(async (tx) => {
					(await tx.doc(Progress, runtime.taskId)).count = 1;
				}, ctx);
				entered.resolve();
				await release.promise;
				await runtime.commit(async (tx) => {
					(await tx.doc(Progress, runtime.taskId)).count = 2;
					return { status: "terminal", outcome: { status: "completed", result: null } };
				}, ctx);
			},
		},
		async abort() {},
	});
	const { session, scheduler } = await open([task]),
		conversationId = await root(session);
	const id = await session.commit(
		(tx) => tx.createTask(task, null, { conversationId, ownership: { kind: "conversation" } }),
		context,
	);
	try {
		scheduler.resume();
		await entered.promise;
		const watch = (await session.watchDoc(Progress, id, context))!;
		const seen: WatchCall<Readonly<{ count: number }>>[] = [],
			observed: WatchCall<Readonly<{ count: number }>>[] = [],
			ends: WatchEnd[] = [];
		watch.start(async (call) => {
			seen.push(call);
		});
		await session.observeDoc(
			Progress,
			id,
			{ advance: (call) => observed.push(call), end: (end) => ends.push(end) },
			context,
		);
		release.resolve();
		expect((await scheduler.waitForTask(id, context)).state).toEqual({
			status: "terminal",
			outcome: { status: "completed", result: null },
		});
		expect(await watch.closed).toEqual({ kind: "ended" });
		expect(await session.snapshot(Progress, id, context)).toBeUndefined();
		expect(seen).toMatchObject([{ kind: "value", value: { count: 1 }, retired: true }]);
		expect(observed).toMatchObject([{ kind: "value", value: { count: 1 }, retired: true }]);
		expect(ends).toEqual([{ kind: "ended" }]);
		expect(session.documentCacheSizes.attached).toBe(0);
	} finally {
		release.resolve();
	}
});
