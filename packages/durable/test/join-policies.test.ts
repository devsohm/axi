import { BACKGROUND_CONTEXT as context, awaitWithContext } from "@axi/objects/context";
import { afterEach, expect, test, vi } from "vitest";
import { defineTask, type TaskId } from "../src/index.ts";
import { idFromNumber } from "../src/ids.ts";
import { closeSchedulers, open, root } from "./scheduler-support.ts";

afterEach(closeSchedulers);

test.each(["failFast", "allSettled"] as const)(
	"%s joins observe durable outcomes and respect sibling cancellation policy",
	async (policy) => {
		const started = Promise.withResolvers<void>(),
			release = Promise.withResolvers<void>();
		const Child = defineTask<"slow" | "fail", { phase: "run" }, null>({
			name: "join.child",
			version: 1,
			initial: () => ({ phase: "run" }),
			phases: {
				run: async (task, runtime, ctx) => {
					if (task.input === "slow") {
						started.resolve();
						await awaitWithContext(release.promise, ctx);
						await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx);
					} else {
						await started.promise;
						await runtime.commit(
							() => ({ status: "terminal", outcome: { status: "failed", error: { message: "child rejected" } } }),
							ctx,
						);
					}
				},
			},
			abort: async (_task, runtime, ctx) => {
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
			},
		});
		type Checkpoint = { phase: "start" } | { phase: "join"; children: TaskId<null>[] };
		const Parent = defineTask<null, Checkpoint, string[]>({
			name: "join.parent",
			version: 1,
			initial: () => ({ phase: "start" }),
			phases: {
				start: async (_task, runtime, ctx) =>
					runtime.commit(async (tx) => {
						const children = await Promise.all(
							(["slow", "fail"] as const).map((input) =>
								tx.createTask(Child, input, {
									conversationId: runtime.conversationId,
									ownership: { kind: "task", taskId: runtime.taskId },
								}),
							),
						);
						return { status: "waiting", checkpoint: { phase: "join", children }, on: children, policy };
					}, ctx),
				join: async (task, runtime, ctx) => {
					const outcomes = await runtime.outcomes(task.state.checkpoint.children, ctx);
					expect((await runtime.ownedTasks(ctx)).every((child) => child.state.status === "terminal")).toBe(true);
					await runtime.commit(
						() => ({
							status: "terminal",
							outcome: { status: "completed", result: outcomes.map(({ status }) => status) },
						}),
						ctx,
					);
				},
			},
			abort: async (_task, runtime, ctx) => {
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
			},
		});
		const { session, scheduler, storage, reports } = await open([Parent, Child]);
		const conversationId = await root(session);
		const parent = await session.commit(
			(tx) => tx.createTask(Parent, null, { conversationId, ownership: { kind: "conversation" } }),
			context,
		);
		try {
			scheduler.resume();
			await started.promise;
			if (policy === "allSettled") {
				await vi.waitFor(async () =>
					expect((await storage.task(parent, context))?.state).toMatchObject({ status: "waiting", policy }),
				);
				release.resolve();
			}
			expect((await scheduler.waitForTask(parent, context)).state).toEqual({
				status: "terminal",
				outcome: { status: "completed", result: [policy === "failFast" ? "aborted" : "completed", "failed"] },
			});
			await scheduler.waitForIdle(conversationId, context);
			expect(await scheduler.abort(parent, context)).toBe("terminal");
			expect(reports).toEqual([]);
		} finally {
			release.resolve();
		}
	},
);

test.each(["self", "missing", "unowned"] as const)(
	"a %s wait is rejected before an invalid dependency is persisted",
	async (kind) => {
		const Peer = defineTask<null, { phase: "wait" }, null>({
			name: "peer",
			version: 1,
			initial: () => ({ phase: "wait" }),
			phases: {
				wait: async (_task, runtime, ctx) => {
					await runtime.sleepUntil(Number.MAX_SAFE_INTEGER, { phase: "wait" }, ctx);
				},
			},
			abort: async (_task, runtime, ctx) => {
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
			},
		});
		let other = idFromNumber<TaskId>(999_999);
		const Task = defineTask<null, { phase: "run" }, null>({
			name: "invalid.wait",
			version: 1,
			initial: () => ({ phase: "run" }),
			phases: {
				run: async (_task, runtime, ctx) => {
					await runtime.commit(
						() => ({
							status: "waiting",
							checkpoint: { phase: "run" },
							on: [kind === "self" ? runtime.taskId : other],
							policy: kind === "unowned" ? "failFast" : "allSettled",
						}),
						ctx,
					);
				},
			},
			abort: async () => {},
		});
		const { session, scheduler } = await open([Task, Peer]);
		const conversationId = await root(session);
		if (kind === "unowned")
			other = await session.commit(
				(tx) => tx.createTask(Peer, null, { conversationId, ownership: { kind: "conversation" } }),
				context,
			);
		const task = await session.commit(
			(tx) => tx.createTask(Task, null, { conversationId, ownership: { kind: "conversation" } }),
			context,
		);
		scheduler.resume();
		const outcome = (await scheduler.waitForTask(task, context)).state.outcome;
		expect(outcome).toMatchObject({
			status: "faulted",
			error: {
				message: expect.stringMatching(
					kind === "self" ? /cycle|itself/i : kind === "missing" ? /does not exist/ : /only on tasks it owns/,
				),
			},
		});
		if (kind === "unowned") await scheduler.abort(other, context);
	},
);
