import { BACKGROUND_CONTEXT as context, awaitWithContext } from "@axi/objects/context";
import { afterEach, expect, test, vi } from "vitest";
import { defineTask, MemoryStorage, ROOT_CONVERSATION_ID, type TaskId } from "../src/index.ts";
import { idFromNumber } from "../src/ids.ts";
import { commitWrites } from "../src/testing/commit-writes.ts";
import { closeSchedulers, open, root } from "./scheduler-support.ts";

afterEach(closeSchedulers);

test.each(["pending", "running"] as const)(
	"recovered %s work marked abandonOnRestart takes its restart abort path",
	async (status) => {
		const events: string[] = [];
		const task = defineTask<null, { phase: "run" }, null>({
			name: "recovery-abandon",
			version: 1,
			initial: () => ({ phase: "run" }),
			phases: {
				async run() {
					events.push("executed");
				},
			},
			async abort(record, runtime, ctx) {
				events.push(record.abortReason ?? "ordinary abort");
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
			},
		});
		const storage = new MemoryStorage(),
			id = idFromNumber<TaskId<null>>(2);
		await commitWrites(
			storage,
			[
				{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } },
				{
					type: "task",
					value: {
						id,
						kind: task.definition.name,
						version: 1,
						input: null,
						conversationId: ROOT_CONVERSATION_ID,
						background: false,
						abandonOnRestart: true,
						abortRequested: false,
						state: { status, checkpoint: { phase: "run" } },
					},
				},
			],
			context,
		);
		const { scheduler, registry } = await open([task], { storage });
		expect((await scheduler.inspect(registry.snapshot())).scheduling).toBe("paused");
		scheduler.resume();
		expect((await scheduler.waitForTask(id, context)).state).toEqual({
			status: "terminal",
			outcome: { status: "aborted" },
		});
		expect(events).toEqual(["restart"]);
	},
);

test("a recovered abort handler at its restart limit faults without running again", async () => {
	let executions = 0;
	const task = defineTask<null, { phase: "run" }, null>({
		name: "bounded-abort",
		version: 1,
		initial: () => ({ phase: "run" }),
		phases: {
			async run() {
				executions++;
			},
		},
		async abort() {
			executions++;
		},
	});
	const storage = new MemoryStorage(),
		id = idFromNumber<TaskId<null>>(2);
	await commitWrites(
		storage,
		[
			{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } },
			{
				type: "task",
				value: {
					id,
					kind: task.definition.name,
					version: 1,
					input: null,
					conversationId: ROOT_CONVERSATION_ID,
					background: false,
					abortRequested: true,
					abortReason: "restart",
					restarts: 1,
					state: { status: "running", checkpoint: { phase: "run" } },
				},
			},
		],
		context,
	);
	const { scheduler, reports } = await open([task], { storage, settings: { restartLimit: 2 } });
	expect(await scheduler.abort(id, context, true)).toBe("marked");
	scheduler.resume();
	expect((await scheduler.waitForTask(id, context)).state).toMatchObject({
		status: "terminal",
		outcome: {
			status: "faulted",
			error: { message: expect.stringContaining("Abort handler"), detail: { reason: "restart_limit" } },
		},
	});
	expect(executions).toBe(0);
	await vi.waitFor(() =>
		expect(reports.map((report) => report.info)).toMatchObject([{ kind: "task_faulted", reason: "restart_limit" }]),
	);
});

test.each(["returns", "throws", "settles-then-throws"] as const)(
	"abort handler that %s preserves the correct durable outcome",
	async (mode) => {
		let ran = false;
		const task = defineTask<null, { phase: "run" }, null>({
			name: "abort-boundary",
			version: 1,
			initial: () => ({ phase: "run" }),
			phases: {
				async run() {
					ran = true;
				},
			},
			async abort(_record, runtime, ctx) {
				if (mode === "settles-then-throws")
					await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
				if (mode !== "returns") throw new Error("Abort adapter failed");
			},
		});
		const { session, scheduler } = await open([task]),
			conversationId = await root(session);
		const id = await session.commit(
			(tx) => tx.createTask(task, null, { conversationId, ownership: { kind: "conversation" } }),
			context,
		);
		expect(await scheduler.abort(id, context)).toBe("marked");
		scheduler.resume();
		const record = await scheduler.waitForTask(id, context);
		expect(record.state).toMatchObject(
			mode === "settles-then-throws"
				? { status: "terminal", outcome: { status: "aborted" } }
				: {
						status: "terminal",
						outcome: {
							status: "faulted",
							error: {
								message: expect.stringMatching(
									mode === "returns" ? /without a terminal outcome/ : /Abort adapter failed/,
								),
							},
						},
					},
		);
		expect(ran).toBe(false);
		expect(await scheduler.abort(id, context)).toBe("terminal");
	},
);

test.each(["missing_task", "task_too_old", "migration_failed"] as const)(
	"cancelling a blocked %s definition settles it as orphaned",
	async (reason) => {
		const task = defineTask<null, { phase: "run" }, null>({
			name: "orphaned-definition",
			version: 2,
			initial: () => ({ phase: "run" }),
			phases: {
				async run() {
					throw new Error("Blocked task executed");
				},
			},
			async abort() {
				throw new Error("Incompatible abort handler executed");
			},
		});
		const replacement =
			reason === "missing_task" ? [] : [defineTask({ ...task.definition, version: reason === "task_too_old" ? 1 : 3 })];
		const { session, scheduler, registry } = await open(replacement),
			conversationId = await root(session);
		const id = await session.commit(
			(tx) => tx.createTask(task, null, { conversationId, ownership: { kind: "conversation" } }),
			context,
		);
		expect((await scheduler.inspect(registry.snapshot())).tasks).toMatchObject([
			{ record: { id }, state: { kind: "blocked", reason } },
		]);
		expect(await scheduler.abort(id, context)).toBe("marked");
		expect((await scheduler.waitForTask(id, context)).state).toEqual({
			status: "terminal",
			outcome: { status: "orphaned", reason },
		});
	},
);

test("conversation cancellation preserves background work until it is explicitly included", async () => {
	const foreground = Promise.withResolvers<void>(),
		background = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	const aborted: string[] = [];
	const task = defineTask<string, { phase: "run" }, null>({
		name: "background-work",
		version: 1,
		initial: () => ({ phase: "run" }),
		phases: {
			async run(record, runtime, ctx) {
				(record.input === "foreground" ? foreground : background).resolve();
				await awaitWithContext(release.promise, ctx);
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx);
			},
		},
		async abort(record, runtime, ctx) {
			aborted.push(record.input);
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
		},
	});
	const { session, scheduler, storage } = await open([task]),
		conversationId = await root(session);
	const ids = await session.commit(
		async (tx) => [
			await tx.createTask(task, "foreground", { conversationId, ownership: { kind: "conversation" } }),
			await tx.createTask(task, "background", {
				conversationId,
				ownership: { kind: "conversation" },
				background: true,
			}),
		],
		context,
	);
	try {
		scheduler.resume();
		await Promise.all([foreground.promise, background.promise]);
		await scheduler.abortConversation(conversationId, false, context);
		expect((await storage.task(ids[0]!, context))?.state).toMatchObject({
			status: "terminal",
			outcome: { status: "aborted" },
		});
		expect((await storage.task(ids[1]!, context))?.state.status).toBe("running");
		expect(aborted).toEqual(["foreground"]);
		await scheduler.abortConversation(conversationId, true, context);
		expect((await scheduler.waitForTask(ids[1]!, context)).state).toEqual({
			status: "terminal",
			outcome: { status: "aborted" },
		});
		expect(aborted).toEqual(["foreground", "background"]);
	} finally {
		release.resolve();
	}
});
