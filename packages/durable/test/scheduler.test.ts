import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context } from "@axi/chord";
import { BACKGROUND_CONTEXT as context, awaitWithContext } from "@axi/chord/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineDoc, defineTask, MemoryStorage } from "../src/index.ts";
import type { Agent } from "../src/harness/types.ts";
import { SessionImpl } from "../src/session/session.ts";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import type { StorageWrite, TaskId, TaskRuntime } from "../src/types.ts";
import { agent, open, root, closeSchedulers, Definitions } from "./scheduler-support.ts";

const directories: string[] = [];
afterEach(async () => {
	await closeSchedulers();
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
function completed(): {
	readonly status: "terminal";
	readonly outcome: { readonly status: "completed"; readonly result: null };
};
function completed<T extends number | null>(
	result: T,
): { readonly status: "terminal"; readonly outcome: { readonly status: "completed"; readonly result: T } };
function completed(result: number | null = null) {
	return { status: "terminal", outcome: { status: "completed", result } } as const;
}
async function eventually(check: () => boolean | Promise<boolean>): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	throw new Error("Task state did not settle");
}
const Counter = defineTask<number, { phase: "first" } | { phase: "second"; key: string }, number>({
	name: "counter",
	version: 1,
	initial: () => ({ phase: "first" }),
	phases: {
		first: async (_task, runtime, ctx) => {
			const [a, b] = await Promise.all([
				runtime.memo<string>("__proto__", "first", ctx),
				runtime.memo<string>("__proto__", "second", ctx),
			]);
			if (a !== "first" || b !== "first") throw new Error("Memo changed");
			await runtime.commit(() => ({ status: "running", checkpoint: { phase: "second", key: a } }), ctx);
		},
		second: async (task, runtime, ctx) => runtime.commit(() => completed(task.input + 1), ctx),
	},
	abort: async (_task, runtime, ctx) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});

describe("task scheduler", () => {
	it("reports registry lookup failures once across temporary recovery", async () => {
		const opened = await open([Counter]);
		const conversationId = await root(opened.session);
		const id = await opened.session.commit(
			(tx) => tx.createTask(Counter, 0, { ownership: { kind: "conversation" }, conversationId }),
			context,
		);
		const snapshot = opened.registry.snapshot();
		let fail = true;
		const spy = vi.spyOn(opened.registry, "snapshot").mockImplementation(() => {
			if (fail) throw new Error("registry unavailable");
			return snapshot;
		});
		try {
			const subject = { id, kind: "counter", version: 1, abortRequested: false, status: "pending" as const };
			opened.scheduler.blockedReason(subject);
			fail = false;
			opened.scheduler.blockedReason(subject);
			fail = true;
			opened.scheduler.blockedReason(subject);
			expect(
				opened.reports.filter(({ info }) => info.type === "host_error" && info.callback === "registry"),
			).toHaveLength(1);
			spy.mockReturnValue({
				...snapshot,
				task() {
					throw new Error("task lookup failed");
				},
			});
			expect(() => opened.scheduler.blockedReason(subject)).toThrow("task lookup failed");
		} finally {
			spy.mockRestore();
		}
	});
	it("fixes the registry and agent per phase and binds hook handlers to their owner", async () => {
		let publish = () => {};
		let resolutions = 0;
		const hooks: number[] = [];
		const Task = defineTask<null, { phase: "first" } | { phase: "second" }, null, { event(): void }>({
			name: "phase-snapshots",
			version: 1,
			initial: () => ({ phase: "first" }),
			phases: {
				first: async (_task, runtime, ctx) => {
					expect(runtime.registry.task("counter")).toBeUndefined();
					publish();
					expect(runtime.registry.task("counter")).toBeUndefined();
					const first = await runtime.agent(ctx);
					await runtime.hooks.each("event", (handler) => handler());
					expect(await runtime.agent(ctx)).toBe(first);
					await runtime.commit(() => ({ status: "running", checkpoint: { phase: "second" } }), ctx);
				},
				second: async (_task, runtime, ctx) => {
					expect(runtime.registry.task("counter")).toBe(Counter);
					await runtime.hooks.each("event", (handler) => handler());
					await runtime.commit(() => completed(), ctx);
				},
			},
			abort: async () => {},
		});
		const { session, scheduler, registry } = await open([Task], {
			agent: async () => {
				const handlers = {
					revision: ++resolutions,
					event() {
						hooks.push(this.revision);
					},
				};
				return { ...agent, extensions: [{ name: "hooks", hooks: [{ task: Task.definition.name, handlers }] }] };
			},
		});
		publish = () => registry.replace([Task, Counter]);
		const conversation = await root(session);
		const id = await session.commit(
			(tx) => tx.createTask(Task, null, { ownership: { kind: "conversation" }, conversationId: conversation }),
			context,
		);
		scheduler.resume();
		expect((await scheduler.waitForTask(id, context)).state).toEqual(completed());
		expect(hooks).toEqual([1, 2]);
		expect(resolutions).toBe(2);
	});
	it("does not advance a child while the durable cancellation cascade is held", async () => {
		const entered = Promise.withResolvers<void>(),
			release = Promise.withResolvers<void>(),
			advance = Promise.withResolvers<void>(),
			childEntered = Promise.withResolvers<void>();
		class HeldMarks extends MemoryStorage {
			target: TaskId | undefined;
			override async commit(writes: readonly StorageWrite[], ctx: Context) {
				if (
					writes.some((write) => write.type === "task" && write.value.id === this.target && write.value.abortRequested)
				) {
					entered.resolve();
					await release.promise;
				}
				return super.commit(writes, ctx);
			}
		}
		let advanced = false;
		const Parent = defineTask<null, { phase: "hold" }, null>({
			name: "cancel-parent",
			version: 1,
			initial: () => ({ phase: "hold" }),
			phases: { hold: async (_task, _runtime, ctx) => awaitWithContext(new Promise<void>(() => {}), ctx) },
			abort: async (_task, runtime, ctx) =>
				runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
		});
		const Child = defineTask<null, { phase: "first" } | { phase: "next" }, null>({
			name: "cancel-child",
			version: 1,
			initial: () => ({ phase: "first" }),
			phases: {
				first: async (_task, runtime, ctx) => {
					childEntered.resolve();
					await advance.promise;
					await runtime.commit(() => ({ status: "running", checkpoint: { phase: "next" } }), ctx);
				},
				next: async (_task, _runtime, ctx) => {
					advanced = true;
					await awaitWithContext(new Promise<void>(() => {}), ctx);
				},
			},
			abort: async (_task, runtime, ctx) =>
				runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
		});
		const storage = new HeldMarks(),
			{ session, scheduler } = await open([Parent, Child], { storage }),
			conversation = await root(session);
		const { parent, child } = await session.commit(async (tx) => {
			const parent = await tx.createTask(Parent, null, {
				ownership: { kind: "conversation" },
				conversationId: conversation,
			});
			const child = await tx.createTask(Child, null, { ownership: { kind: "task", taskId: parent } });
			return { parent, child };
		}, context);
		storage.target = child;
		try {
			scheduler.resume();
			await childEntered.promise;
			const aborting = scheduler.abort(parent, context);
			await entered.promise;
			advance.resolve();
			await new Promise((resolve) => setTimeout(resolve, 5));
			expect(advanced).toBe(false);
			release.resolve();
			await aborting;
			expect((await scheduler.waitForTask(child, context)).state.outcome).toEqual({ status: "aborted" });
			expect((await scheduler.waitForTask(parent, context)).state.outcome).toEqual({ status: "aborted" });
			expect(advanced).toBe(false);
		} finally {
			release.resolve();
			advance.resolve();
		}
	});
	it("writes a cleanly closed invocation back as pending without a crash count", async () => {
		const directory = await mkdtemp(join(tmpdir(), "axi-scheduler-close-"));
		directories.push(directory);
		const path = join(directory, "session.sqlite");
		let finish = false;
		const Work = defineTask<null, { phase: "work" }, null>({
			name: "clean-close",
			version: 1,
			initial: () => ({ phase: "work" }),
			phases: {
				work: async (_task, runtime, ctx) => {
					if (!finish) await awaitWithContext(new Promise<void>(() => {}), ctx);
					await runtime.commit(() => completed(), ctx);
				},
			},
			abort: async () => {},
		});
		const first = await open([Work], { storage: await openNodeSqliteStorage(path), now: () => 100 }),
			conversation = await root(first.session);
		const id = await first.session.commit(
			(tx) => tx.createTask(Work, null, { ownership: { kind: "conversation" }, conversationId: conversation }),
			context,
		);
		first.scheduler.resume();
		await eventually(async () => (await first.storage.task(id, context))?.state.status === "running");
		await first.session.close(context);
		finish = true;
		const second = await open([Work], { storage: await openNodeSqliteStorage(path), now: () => 200 });
		const record = await second.storage.task(id, context);
		expect(record?.state).toEqual({ status: "pending", checkpoint: { phase: "work" } });
		expect(record).not.toHaveProperty("restarts");
		expect(record?.startedAt).toBe(100);
		second.scheduler.resume();
		const result = await second.scheduler.waitForTask(id, context);
		expect(result.state).toEqual(completed());
		expect(result.startedAt).toBe(100);
		expect(result.endedAt).toBe(200);
	});
	it("runs durable phases, shares first-writer memos and drops them on completion", async () => {
		const { session, storage, scheduler } = await open([Counter]);
		const conversation = await root(session);
		const id = await session.commit(
			(tx) => tx.createTask(Counter, 4, { ownership: { kind: "conversation" }, conversationId: conversation }),
			context,
		);
		expect((await scheduler.inspect(new Definitions([Counter]).snapshot())).scheduling).toBe("paused");
		scheduler.resume();
		const result = await scheduler.waitForTask(id, context);
		expect(result.state).toEqual(completed(5));
		expect(result).not.toHaveProperty("memos");
		expect((await storage.task(id, context))?.state).toEqual(completed(5));
		await scheduler.waitForIdle(conversation, context);
		await eventually(() => Object.values(scheduler.indexSizes).every((value) => value === 0));
	});
	it("faults a phase without progress and preserves an outcome committed before a late throw", async () => {
		const Stuck = defineTask<null, { phase: "start" }, null>({
			name: "stuck",
			version: 1,
			initial: () => ({ phase: "start" }),
			phases: { start: async () => {} },
			abort: async () => {},
		});
		const Late = defineTask<null, { phase: "start" }, null>({
			name: "late",
			version: 1,
			initial: () => ({ phase: "start" }),
			phases: {
				start: async (_task, runtime, ctx) => {
					await runtime.commit(() => completed(), ctx);
					throw new Error("late");
				},
			},
			abort: async () => {},
		});
		const { session, scheduler, reports } = await open([Stuck, Late]),
			conversation = await root(session);
		const ids = await session.commit(
			async (tx) => [
				await tx.createTask(Stuck, null, { ownership: { kind: "conversation" }, conversationId: conversation }),
				await tx.createTask(Late, null, { ownership: { kind: "conversation" }, conversationId: conversation }),
			],
			context,
		);
		scheduler.resume();
		const [stuck, late] = await Promise.all(ids.map((id) => scheduler.waitForTask(id, context)));
		expect(stuck?.state.outcome).toEqual({
			status: "faulted",
			error: { message: "Task stuck phase start returned without durable progress" },
		});
		expect(late?.state).toEqual(completed());
		expect(reports.filter((r) => r.info.type === "task_faulted")).toHaveLength(1);
	});
	it("holds the owner's result until its child ends and keeps documents until finalization", async () => {
		const gate = Promise.withResolvers<void>();
		let child: TaskId | undefined;
		const Document = defineDoc({
			checkpointWhen: () => false,
			kind: "held",
			version: 1,
			scope: "task",
			initial: () => ({ value: 7 }),
		});
		const Child = defineTask<null, { phase: "wait" }, null>({
			name: "child",
			version: 1,
			initial: () => ({ phase: "wait" }),
			phases: {
				wait: async (_task, runtime, ctx) => {
					await awaitWithContext(gate.promise, ctx);
					await runtime.commit(() => completed(), ctx);
				},
			},
			abort: async (_task, runtime, ctx) =>
				runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
		});
		const Parent = defineTask<null, { phase: "spawn" } | { phase: "end" }, null>({
			name: "parent",
			version: 1,
			initial: () => ({ phase: "spawn" }),
			phases: {
				spawn: async (task, runtime, ctx) =>
					runtime.commit(async (tx) => {
						child = await tx.createTask(Child, null, { ownership: { kind: "task", taskId: task.id } });
						await tx.doc(Document, task.id);
						return { status: "running", checkpoint: { phase: "end" } };
					}, ctx),
				end: async (_task, runtime, ctx) => runtime.commit(() => completed(), ctx),
			},
			abort: async () => {},
		});
		const { session, storage, scheduler } = await open([Parent, Child]),
			conversation = await root(session);
		const id = await session.commit(
			(tx) => tx.createTask(Parent, null, { ownership: { kind: "conversation" }, conversationId: conversation }),
			context,
		);
		scheduler.resume();
		await eventually(async () => (await storage.task(id, context))?.state.status === "completing");
		expect(await session.snapshot(Document, id, context)).toEqual({ value: 7 });
		gate.resolve();
		expect((await scheduler.waitForTask(id, context)).state).toEqual(completed());
		expect((await storage.task(child!, context))?.state).toEqual(completed());
		expect(await session.snapshot(Document, id, context)).toBeUndefined();
	});
	it("aborts children before their owner's handler", async () => {
		const order: string[] = [];
		let child: TaskId | undefined;
		const Hold = defineTask<{ name: string }, { phase: "hold" }, null>({
			name: "hold",
			version: 1,
			initial: () => ({ phase: "hold" }),
			phases: {
				hold: async (_task, _runtime, ctx) => {
					await awaitWithContext(new Promise<void>(() => {}), ctx);
				},
			},
			abort: async (task, runtime, ctx) => {
				order.push(task.input.name);
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
			},
		});
		const { session, storage, scheduler } = await open([Hold]),
			conversation = await root(session);
		const parent = await session.commit(async (tx) => {
			const id = await tx.createTask(
				Hold,
				{ name: "parent" },
				{ ownership: { kind: "conversation" }, conversationId: conversation },
			);
			child = await tx.createTask(Hold, { name: "child" }, { ownership: { kind: "task", taskId: id } });
			return id;
		}, context);
		scheduler.resume();
		await eventually(async () => (await storage.task(parent, context))?.state.status === "running");
		await scheduler.abort(parent, context);
		await scheduler.waitForTask(parent, context);
		expect(order).toEqual(["child", "parent"]);
		expect((await storage.task(child!, context))?.state).toEqual({
			status: "terminal",
			outcome: { status: "aborted" },
		});
	});
	it("sleeps without an active invocation and resumes exactly once when due", async () => {
		let time = 100,
			runs = 0;
		const Nap = defineTask<null, { phase: "sleep" } | { phase: "wake" }, number>({
			name: "nap",
			version: 1,
			initial: () => ({ phase: "sleep" }),
			phases: {
				sleep: async (_task, runtime, ctx) => runtime.sleepUntil(200, { phase: "wake" }, ctx),
				wake: async (_task, runtime, ctx) => {
					runs++;
					await runtime.commit(() => completed(runtime.now()), ctx);
				},
			},
			abort: async () => {},
		});
		const { session, storage, scheduler } = await open([Nap], { now: () => time }),
			conversation = await root(session);
		const id = await session.commit(
			(tx) => tx.createTask(Nap, null, { ownership: { kind: "conversation" }, conversationId: conversation }),
			context,
		);
		scheduler.resume();
		await eventually(
			async () => (await storage.task(id, context))?.state.status === "sleeping" && !scheduler.wake().active,
		);
		expect(scheduler.wake()).toEqual({ active: false, at: 200 });
		time = 199;
		scheduler.resume();
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(runs).toBe(0);
		time = 200;
		scheduler.resume();
		scheduler.resume();
		expect((await scheduler.waitForTask(id, context)).state).toEqual(completed(200));
		expect(runs).toBe(1);
	});
	it("blocks a missing definition and resumes it after registry publication", async () => {
		const { session, scheduler, registry } = await open([]),
			conversation = await root(session);
		const id = await session.commit(
			(tx) => tx.createTask(Counter, 8, { ownership: { kind: "conversation" }, conversationId: conversation }),
			context,
		);
		scheduler.resume();
		await eventually(async () => (await scheduler.inspect(registry.snapshot())).tasks[0]?.state.kind === "blocked");
		expect((await scheduler.inspect(registry.snapshot())).tasks[0]?.state).toEqual({
			kind: "blocked",
			reason: "missing_task",
		});
		registry.replace([Counter]);
		expect((await scheduler.waitForTask(id, context)).state).toEqual(completed(9));
	});
	it("invalidates one failed migration only when its definition object changes", async () => {
		let migrations = 0;
		const Bad = defineTask({
			...Counter.definition,
			version: 2,
			migrate: () => {
				migrations++;
				throw new Error("cannot migrate");
			},
		});
		const { session, scheduler, registry } = await open([Bad]),
			conversation = await root(session);
		const id = await session.commit(
			(tx) => tx.createTask(Counter, 9, { ownership: { kind: "conversation" }, conversationId: conversation }),
			context,
		);
		scheduler.resume();
		await eventually(() => migrations === 1);
		registry.replace([Bad]);
		scheduler.resume();
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(migrations).toBe(1);
		registry.replace([Counter]);
		expect((await scheduler.waitForTask(id, context)).state).toEqual(completed(10));
	});
	it("shares an agent promise within a phase and cancels only the caller's wait", async () => {
		const resolved = Promise.withResolvers<Agent>();
		let calls = 0;
		const Await = defineTask<null, { phase: "agent" }, null>({
			name: "agent",
			version: 1,
			initial: () => ({ phase: "agent" }),
			phases: {
				agent: async (_task, runtime, ctx) => {
					const controller = new AbortController(),
						caller: Context = { ...ctx, abortSignal: controller.signal };
					const cancelled = runtime.agent(caller);
					controller.abort(new Error("caller ended"));
					await expect(cancelled).rejects.toThrow("caller ended");
					const value = await runtime.agent(ctx);
					expect(value).toBe(agent);
					await runtime.commit(() => completed(), ctx);
				},
			},
			abort: async () => {},
		});
		const { session, scheduler } = await open([Await], {
				agent: async () => {
					calls++;
					return resolved.promise;
				},
			}),
			conversation = await root(session);
		const id = await session.commit(
			(tx) => tx.createTask(Await, null, { ownership: { kind: "conversation" }, conversationId: conversation }),
			context,
		);
		scheduler.resume();
		await eventually(() => calls === 1);
		resolved.resolve(agent);
		expect((await scheduler.waitForTask(id, context)).state).toEqual(completed());
		expect(calls).toBe(1);
	});
	it("expires runtime controls and watches when its invocation ends", async () => {
		let runtimeAfter: TaskRuntime<null, { phase: "start" }, null, object> | undefined;
		const Document = defineDoc({
			checkpointWhen: () => false,
			kind: "observed",
			version: 1,
			scope: "session",
			initial: () => ({ count: 0 }),
		});
		let watch: Awaited<ReturnType<SessionImpl["watchDoc"]>>;
		const Once = defineTask<null, { phase: "start" }, null>({
			name: "once",
			version: 1,
			initial: () => ({ phase: "start" }),
			phases: {
				start: async (_task, runtime, ctx) => {
					runtimeAfter = runtime;
					watch = await runtime.watchDoc(Document, ctx);
					await runtime.commit(() => completed(), ctx);
				},
			},
			abort: async () => {},
		});
		const { session, scheduler } = await open([Once]),
			conversation = await root(session);
		await session.commit((tx) => tx.doc(Document), context);
		const id = await session.commit(
			(tx) => tx.createTask(Once, null, { ownership: { kind: "conversation" }, conversationId: conversation }),
			context,
		);
		scheduler.resume();
		await scheduler.waitForTask(id, context);
		await eventually(() => runtimeAfter?.signal.aborted === true);
		expect(await watch!.closed).toEqual({ reason: "stopped" });
		await expect(runtimeAfter!.memo("late", 1, context)).rejects.toThrow("invocation has ended");
		expect(() => runtimeAfter!.now()).toThrow("invocation has ended");
	});
	it("parks crash-recovered running work and retries from its persisted checkpoint", async () => {
		const directory = await mkdtemp(join(tmpdir(), "axi-scheduler-"));
		directories.push(directory);
		const path = join(directory, "session.sqlite");
		const storage = await openNodeSqliteStorage(path),
			session = new SessionImpl(storage);
		const conversation = (
			await session.commit((tx) => tx.createConversation({ ownership: { kind: "ownerless" } }), context)
		).id;
		const id = await session.commit(
			(tx) => tx.createTask(Counter, 10, { ownership: { kind: "conversation" }, conversationId: conversation }),
			context,
		);
		await session.commitWith(async (tx) => {
			const task = (await tx.task(id))!;
			tx.setTask({ ...task, restarts: 4, state: { status: "running", checkpoint: { phase: "second", key: "saved" } } });
		}, context);
		await session.close(context);
		const opened = await open([Counter], { storage: await openNodeSqliteStorage(path) });
		expect((await opened.scheduler.inspect(opened.registry.snapshot())).tasks[0]?.state).toEqual({
			kind: "blocked",
			reason: "restart_limit",
		});
		expect((await opened.storage.task(id, context))?.restarts).toBe(5);
		await opened.scheduler.retry(id, context);
		expect((await opened.scheduler.waitForTask(id, context)).state).toEqual(completed(11));
	});
});
