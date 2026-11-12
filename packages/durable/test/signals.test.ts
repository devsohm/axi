import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context, withAbortSignal } from "@axi/objects/context";
import { Type } from "typebox";
import { afterEach, expect, test, vi } from "vitest";
import { createModels } from "@axi/ai";
import {
	createRegistry,
	defineExtension,
	defineSignal,
	defineTask,
	Harness,
	MemoryStorage,
	ReadAfterWrite,
	SubmissionSettled,
	type SignalState,
	type WakeReason,
} from "../src/index.ts";
import { checkSleep, deliverSignal, readSignal, sleepDue, sleepWake } from "../src/signals.ts";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { commitWrites } from "../src/testing/commit-writes.ts";
import { closeSchedulers, open, root } from "./scheduler-support.ts";

const Reply = defineSignal({ name: "reply", version: 1, schema: Type.Object({ answer: Type.String() }) });
type Result = { wake: WakeReason | null; reply: SignalState<{ answer: string }> | null };
const Ask = defineTask<{ until?: number }, { phase: "park" | "read" }, Result>({
	name: "signal-test.ask",
	version: 1,
	initial: () => ({ phase: "park" }),
	phases: {
		park: (task, runtime, ctx) =>
			runtime.commit(
				() => ({ status: "sleeping", checkpoint: { phase: "read" }, signals: [Reply.key("answer")], ...task.input }),
				ctx,
			),
		read: async (task, runtime, ctx) => {
			const reply = await runtime.readSignal(Reply, "answer", ctx);
			await runtime.commit(
				() => ({
					status: "terminal",
					outcome: { status: "completed", result: { wake: task.state.wake ?? null, reply: reply ?? null } },
				}),
				ctx,
			);
		},
	},
	abort: (_task, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});
const directories: string[] = [];
afterEach(async () => {
	await closeSchedulers();
	for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});

test("signal definitions reject non-JSON types while leaving annotations as data", () => {
	for (const [name, version] of [
		["", 1],
		["two/parts", 1],
		["version", 0],
		["version", 1.5],
	] as const)
		expect(() => defineSignal({ name, version, schema: Type.String() })).toThrow(TypeError);
	for (const schema of [Type.BigInt(), Type.Object({ value: Type.Undefined() }), Type.Array(Type.BigInt())])
		expect(() => defineSignal({ name: "non-json", version: 1, schema })).toThrow(/non-JSON/);
	expect(() =>
		defineSignal({ name: "annotated", version: 1, schema: Type.String({ examples: [{ type: "bigint" }] }) }),
	).not.toThrow();
	expect(Reply.key("answer")).toEqual({ signal: "reply", key: "answer" });
	expect(() => Reply.key("")).toThrow(/non-empty/);
});

test.each([false, true])("a signal delivered before or during a sleep wakes the task (%s)", async (early) => {
	const { session, scheduler, storage } = await open([Ask]);
	const conversationId = await root(session);
	const id = await session.commit(
		(tx) => tx.createTask(Ask, {}, { conversationId, ownership: { kind: "conversation" } }),
		context,
	);
	if (!early) {
		scheduler.resume();
		await vi.waitFor(async () => expect((await storage.task(id, context))?.state.status).toBe("sleeping"));
		expect(scheduler.wake()).toEqual({ active: false });
	}
	const value = { answer: "accepted" };
	expect(await session.commit((tx) => tx.signal(id, Reply, "answer", value), context)).toBe("delivered");
	value.answer = "mutated caller";
	if (early) {
		expect(await session.commit((tx) => tx.signal(id, Reply, "answer", { answer: "duplicate" }), context)).toBe(
			"duplicate",
		);
		scheduler.resume();
	}
	const result = await scheduler.waitForTask(id, context);
	expect(result.state.outcome).toEqual({
		status: "completed",
		result: { wake: { reason: "signal", signal: "reply", key: "answer" }, reply: { value: { answer: "accepted" } } },
	});
	expect(await session.commit((tx) => tx.signal(id, Reply, "later", { answer: "late" }), context)).toBe("closed");
});

test("signal delivery composes parallel candidates, validates the boundary and respects read-before-write", async () => {
	const { session, storage } = await open([Ask]);
	const conversationId = await root(session);
	const id = await session.commit(
		(tx) => tx.createTask(Ask, {}, { conversationId, ownership: { kind: "conversation" } }),
		context,
	);
	expect(
		await session.commit(
			(tx) => Promise.all([tx.signal(id, Reply, "a", { answer: "one" }), tx.signal(id, Reply, "a", { answer: "two" })]),
			context,
		),
	).toEqual(["delivered", "duplicate"]);
	const unknownId = await storage.mintId<typeof id>();
	expect(await session.commit((tx) => tx.signal(unknownId, Reply, "a", { answer: "none" }), context)).toBe("not_found");
	expect(await session.commit((tx) => tx.signal(id, Reply, "", { answer: "empty key" }), context)).toBe("invalid");
	const Any = defineSignal({ name: "json", version: 1, schema: Type.Any() });
	expect(await session.commit((tx) => tx.signal(id, Any, "a", NaN), context)).toBe("invalid");
	await expect(
		session.commit(async (tx) => {
			await tx.appendEntry(conversationId, { kind: "note", data: null });
			await tx.signal(id, Reply, "b", { answer: "late read" });
		}, context),
	).rejects.toBeInstanceOf(ReadAfterWrite);
});

test("a deadline closes undelivered keys and records expiry rather than a delivered value", async () => {
	let now = 100;
	const { session, scheduler, storage } = await open([Ask], { now: () => now });
	const conversationId = await root(session);
	const id = await session.commit(
		(tx) => tx.createTask(Ask, { until: 1000 }, { conversationId, ownership: { kind: "conversation" } }),
		context,
	);
	scheduler.resume();
	await vi.waitFor(async () => expect((await storage.task(id, context))?.state.status).toBe("sleeping"));
	expect(scheduler.wake()).toEqual({ active: false, at: 1000 });
	now = 1000;
	expect(await session.commit((tx) => tx.signal(id, Reply, "answer", { answer: "too late" }), context)).toBe("closed");
	expect((await scheduler.waitForTask(id, context)).state.outcome).toEqual({
		status: "completed",
		result: { wake: { reason: "expired" }, reply: { expired: true } },
	});
});

test("a signal-only sleep survives SQLite close and reopen", async () => {
	const path = await mkdtemp(join(tmpdir(), "axi-signals-"));
	directories.push(path);
	let current = await open([Ask], { storage: await openNodeSqliteStorage(join(path, "session.db")) });
	const conversationId = await root(current.session);
	const id = await current.session.commit(
		(tx) => tx.createTask(Ask, {}, { conversationId, ownership: { kind: "conversation" } }),
		context,
	);
	current.scheduler.resume();
	await vi.waitFor(async () => expect((await current.storage.task(id, context))?.state.status).toBe("sleeping"));
	await current.session.close(context);
	current = await open([Ask], { storage: await openNodeSqliteStorage(join(path, "session.db")) });
	expect(
		await current.session.commit((tx) => tx.signal(id, Reply, "answer", { answer: "after restart" }), context),
	).toBe("delivered");
	current.scheduler.resume();
	expect((await current.scheduler.waitForTask(id, context)).state.outcome).toMatchObject({
		status: "completed",
		result: { reply: { value: { answer: "after restart" } } },
	});
});

test("recovered wakes survive the same checkpoint without resetting restart accounting", async () => {
	const path = await mkdtemp(join(tmpdir(), "axi-signal-recovery-"));
	directories.push(path);
	const counts: Array<number | undefined> = [],
		wakes: unknown[] = [];
	const task = defineTask<null, { phase: "resume" | "next" }, null>({
		name: "wake-accounting",
		version: 1,
		initial: () => ({ phase: "resume" }),
		phases: {
			resume: async (_task, runtime, ctx) => {
				await runtime.commit(() => ({ status: "running", checkpoint: { phase: "resume" } }), ctx);
				const current = await runtime.getTask(runtime.taskId, ctx);
				counts.push(current?.restarts);
				wakes.push(current && "wake" in current.state ? current.state.wake : undefined);
				await runtime.commit(() => ({ status: "running", checkpoint: { phase: "next" } }), ctx);
			},
			next: async (_task, runtime, ctx) => {
				const current = await runtime.getTask(runtime.taskId, ctx);
				counts.push(current?.restarts);
				wakes.push(current && "wake" in current.state ? current.state.wake : undefined);
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx);
			},
		},
		abort: async () => {},
	});
	const file = join(path, "session.db"),
		first = await open([task], { storage: await openNodeSqliteStorage(file) });
	const conversationId = await root(first.session);
	const id = await first.session.commit(
		(tx) => tx.createTask(task, null, { conversationId, ownership: { kind: "conversation" } }),
		context,
	);
	const pending = await first.storage.task(id, context);
	if (!pending) throw new Error("Missing task");
	await first.session.close(context);
	const storage = await openNodeSqliteStorage(file);
	await commitWrites(
		storage,
		[
			{
				type: "task",
				value: { ...pending, state: { status: "running", checkpoint: { phase: "resume" }, wake: { reason: "time" } } },
			},
		],
		context,
	);
	const reopened = await open([task], { storage });
	reopened.scheduler.resume();
	await reopened.scheduler.waitForTask(id, context);
	expect(counts).toEqual([1, undefined]);
	expect(wakes).toEqual([{ reason: "time" }, undefined]);
});

test("a self-signal in the sleeping checkpoint's commit is retained", async () => {
	const task = defineTask<null, { phase: "send" | "done" }, boolean>({
		name: "self-signal",
		version: 1,
		initial: () => ({ phase: "send" }),
		phases: {
			send: (_task, runtime, ctx) =>
				runtime.commit(async (tx) => {
					expect(await tx.signal(runtime.taskId, Reply, "self", { answer: "kept" })).toBe("delivered");
					return { status: "sleeping", checkpoint: { phase: "done" }, signals: [Reply.key("self")] };
				}, ctx),
			done: async (_task, runtime, ctx) => {
				expect(await runtime.readSignal(Reply, "self", ctx)).toEqual({ value: { answer: "kept" } });
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: true } }), ctx);
			},
		},
		abort: async () => {},
	});
	const { session, scheduler } = await open([task]);
	const conversationId = await root(session);
	const id = await session.commit(
		(tx) => tx.createTask(task, null, { conversationId, ownership: { kind: "conversation" } }),
		context,
	);
	scheduler.resume();
	expect((await scheduler.waitForTask(id, context)).state.outcome).toEqual({ status: "completed", result: true });
});

test("reading committed signal state does not wait on the lookup context", async () => {
	const task = defineTask<null, { phase: "read" }, boolean>({
		name: "signal-lookup",
		version: 1,
		initial: () => ({ phase: "read" }),
		phases: {
			async read(_task, runtime, frame) {
				await runtime.commit(async (tx) => {
					expect(await tx.signal(runtime.taskId, Reply, "ready", { answer: "stored" })).toBe("delivered");
				}, frame);
				const controller = new AbortController();
				controller.abort(new Error("Lookup context ended"));
				const lookup = withAbortSignal(controller.signal, frame);
				expect(await runtime.readSignal(Reply, "ready", lookup)).toEqual({ value: { answer: "stored" } });
				expect(await runtime.readSignal(Reply, "missing", lookup)).toBeUndefined();
				expect(runtime.signal.aborted).toBe(false);
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: true } }), frame);
			},
		},
		async abort() {},
	});
	const registry = createRegistry();
	registry.install(defineExtension({ name: "signal-lookup", tasks: [task] }));
	const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry }, context);
	try {
		const conversation = await harness.root(context);
		const id = await conversation.commit((tx) => tx.createTask(task, null, { ownership: { kind: "conversation" } }), context);
		expect((await harness.waitForTask(id, context)).state.outcome).toEqual({ status: "completed", result: true });
	} finally {
		await harness.close(context);
	}
});

test("an any-policy wait resumes after one dependency ends and reports that dependency", async () => {
	const release = Promise.withResolvers<void>();
	const child = defineTask<boolean, { phase: "run" }, null>({
		name: "any-child",
		version: 1,
		initial: () => ({ phase: "run" }),
		phases: {
			run: async (task, runtime, ctx) => {
				if (task.input) await release.promise;
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx);
			},
		},
		abort: async () => {},
	});
	const wait = defineTask<null, { phase: "spawn" | "done" }, WakeReason | null>({
		name: "any-wait",
		version: 1,
		initial: () => ({ phase: "spawn" }),
		phases: {
			spawn: (task, runtime, ctx) =>
				runtime.commit(async (tx) => {
					const on = await Promise.all(
						[false, true].map((hold) => tx.createTask(child, hold, { ownership: { kind: "task", taskId: task.id } })),
					);
					return { status: "waiting", checkpoint: { phase: "done" }, on, policy: "any" };
				}, ctx),
			done: (task, runtime, ctx) =>
				runtime.commit(
					() => ({ status: "terminal", outcome: { status: "completed", result: task.state.wake ?? null } }),
					ctx,
				),
		},
		abort: async () => {},
	});
	const { session, scheduler, storage } = await open([child, wait]);
	const conversationId = await root(session);
	const id = await session.commit(
		(tx) => tx.createTask(wait, null, { conversationId, ownership: { kind: "conversation" } }),
		context,
	);
	scheduler.resume();
	try {
		await vi.waitFor(async () => expect((await storage.task(id, context))?.state.status).toBe("completing"));
		const record = await storage.task(id, context);
		expect(record?.state.outcome).toMatchObject({
			status: "completed",
			result: { reason: "tasks", ended: [expect.any(Number)] },
		});
	} finally {
		release.resolve();
	}
	expect((await scheduler.waitForTask(id, context)).state.outcome.status).toBe("completed");
});

test("the public signal operation starts scheduling without a separate resume call", async () => {
	const registry = createRegistry();
	registry.install({ name: "questions", tasks: [Ask] });
	const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry }, context);
	try {
		const conversation = await harness.root(context);
		const id = await conversation.commit(
			(tx) => tx.createTask(Ask, {}, { ownership: { kind: "conversation" } }),
			context,
		);
		expect(await harness.signal(id, Reply, "answer", { answer: "ready" }, context)).toBe("delivered");
		await vi.waitFor(async () => expect((await harness.getTask(id, context))?.state.status).toBe("terminal"));
	} finally {
		await harness.close(context);
	}
});

test("a settled submission notifies a sleeping task in the same durable commit", async () => {
	const waiter = defineTask<null, { phase: "park" | "read" }, number>({
		name: "submission-wait",
		version: 1,
		initial: () => ({ phase: "park" }),
		phases: {
			park: (_task, runtime, ctx) =>
				runtime.commit(
					() => ({ status: "sleeping", checkpoint: { phase: "read" }, signals: [SubmissionSettled.key("receipt")] }),
					ctx,
				),
			read: async (_task, runtime, ctx) => {
				const received = await runtime.readSignal(SubmissionSettled, "receipt", ctx);
				if (!received || !("value" in received) || received.value.status !== "done")
					throw new Error("Missing submission receipt");
				await runtime.commit(
					() => ({ status: "terminal", outcome: { status: "completed", result: received.value.id } }),
					ctx,
				);
			},
		},
		abort: async () => {},
	});
	const storage = new MemoryStorage(),
		registry = createRegistry();
	const storedNotices: boolean[] = [];
	const commit = storage.commit.bind(storage);
	storage.commit = (batches, receive, ctx) => {
		for (const writes of batches)
			for (const write of writes)
				if (write.type === "submission" && write.value.notify)
					storedNotices.push(
						writes.some(
							(candidate) =>
								candidate.type === "task" &&
								candidate.value.id === write.value.notify?.taskId &&
								Object.hasOwn(candidate.value.memos ?? {}, "axi.signal.axi.submission-settled/receipt"),
						),
					);
		return commit(batches, receive, ctx);
	};
	registry.install({ name: "submission-waiter", tasks: [waiter] });
	const harness = await Harness.open(storage, { models: createModels(), registry }, context);
	try {
		const conversation = await harness.root(context);
		const id = await conversation.commit(
			(tx) => tx.createTask(waiter, null, { ownership: { kind: "conversation" } }),
			context,
		);
		harness.resume();
		await vi.waitFor(async () => expect((await harness.getTask(id, context))?.state.status).toBe("sleeping"));
		const graph = await harness.watchTaskGraph(context);
		expect(graph.value.tasks[String(id)]?.state).toEqual({
			status: "sleeping",
			phase: "read",
			signals: [{ signal: "axi.submission-settled", key: "receipt" }],
		});
		const submission = await conversation.submit(
			{ type: "write", entry: { kind: "note", data: "receipt" }, notify: { taskId: id, key: "receipt" } },
			context,
		);
		expect((await harness.waitForTask(id, context)).state.outcome).toEqual({
			status: "completed",
			result: submission.id,
		});
		expect((await submission.status(context)).status).toBe("done");
		expect(storedNotices).toEqual([true]);
		expect(await harness.signal(id, Reply, "late", { answer: "late" }, context)).toBe("closed");
	} finally {
		await harness.close(context);
	}
});

test("stored signals migrate explicitly and used or expired waits cannot be reused", () => {
	const old = defineSignal({ name: "versioned", version: 1, schema: Type.Number() });
	const current = defineSignal({
		name: "versioned",
		version: 2,
		schema: Type.String(),
		migrate: (value) => String(value),
	});
	const memos = { "axi.signal.versioned/x": { version: 1, value: 9 } };
	expect(readSignal(memos, current, "x")).toEqual({ value: "9" });
	expect(readSignal(memos, old, "missing")).toBeUndefined();
	const sleep = { status: "sleeping" as const, checkpoint: null, signals: [old.key("x")], until: 1 };
	expect(sleepDue(sleep, memos, 0)).toBe(true);
	const woke = sleepWake(sleep, memos, 1);
	expect(woke?.wake).toEqual({ reason: "signal", signal: "versioned", key: "x" });
	expect(() => checkSleep(sleep, woke?.memos, 1)).toThrow(/already woke/);
	expect(sleepWake({ ...sleep, until: 100 }, undefined, 1)).toBeUndefined();
	expect(sleepWake({ ...sleep, signals: [] }, undefined, 1)?.wake).toEqual({ reason: "time" });
	expect(() => checkSleep({ status: "sleeping", checkpoint: null }, undefined, 1)).toThrow(/without until or signals/);
	expect(() => checkSleep(sleep, sleepWake(sleep, undefined, 1)?.memos, 1)).toThrow(/expired/);
	const newer = { "axi.signal.versioned/x": { version: 3, value: 9 } };
	expect(() => readSignal(newer, current, "x")).toThrow(/newer/);
	expect(() => readSignal(memos, defineSignal({ name: "versioned", version: 2, schema: Type.String() }), "x")).toThrow(
		/no migration/,
	);
	expect(() =>
		readSignal(
			memos,
			defineSignal({ name: "versioned", version: 2, schema: Type.String(), migrate: () => NaN as never }),
			"x",
		),
	).toThrow(/invalid value/);
	expect(deliverSignal(undefined, old, "x", 1, 0)).toEqual({ result: "not_found" });
});
