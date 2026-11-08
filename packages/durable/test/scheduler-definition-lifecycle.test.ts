import { BACKGROUND_CONTEXT as context } from "@axi/objects/context";
import { afterEach, expect, test, vi } from "vitest";
import { defineTask, type TaskId } from "../src/index.ts";
import { idFromNumber } from "../src/ids.ts";
import { closeSchedulers, open, root } from "./scheduler-support.ts";

afterEach(closeSchedulers);
type Checkpoint = { phase: "first" } | { phase: "second" } | { phase: "third" };

test.each(["missing_task", "task_too_old", "migration_failed"] as const)(
	"an active definition survives a %s replacement and reports it once",
	async (reason) => {
		const entered = Promise.withResolvers<void>(),
			released = Promise.withResolvers<void>(),
			phases: string[] = [];
		const original = defineTask<number, Checkpoint, number>({
			name: "definition-survival",
			version: 2,
			initial: () => ({ phase: "first" }),
			phases: {
				async first(_task, runtime, ctx) {
					phases.push("first");
					entered.resolve();
					await released.promise;
					await runtime.commit(() => ({ status: "running", checkpoint: { phase: "second" } }), ctx);
				},
				async second(_task, runtime, ctx) {
					phases.push("second");
					await runtime.commit(() => ({ status: "running", checkpoint: { phase: "third" } }), ctx);
				},
				async third(task, runtime, ctx) {
					phases.push("third");
					await runtime.commit(
						() => ({ status: "terminal", outcome: { status: "completed", result: task.input } }),
						ctx,
					);
				},
			},
			async abort(_task, runtime, ctx) {
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
			},
		});
		const { session, scheduler, registry, reports, storage } = await open([original]),
			conversationId = await root(session);
		const id = await session.commit(
			(tx) => tx.createTask(original, 7, { conversationId, ownership: { kind: "conversation" } }),
			context,
		);
		try {
			scheduler.resume();
			await entered.promise;
			registry.replace(
				reason === "missing_task"
					? []
					: [defineTask({ ...original.definition, version: reason === "task_too_old" ? 1 : 3 })],
			);
			released.resolve();
			expect((await scheduler.waitForTask(id, context)).state).toEqual({
				status: "terminal",
				outcome: { status: "completed", result: 7 },
			});
			await scheduler.waitForIdle(undefined, context);
			expect(phases).toEqual(["first", "second", "third"]);
			expect(reports.map((report) => report.info)).toMatchObject([{ kind: "task_outdated", reason }]);
			expect((await storage.task(id, context))?.version).toBe(2);
		} finally {
			released.resolve();
		}
	},
);

test.each([2, 3])("a compatible version %i replacement takes over at the next durable phase", async (version) => {
	const entered = Promise.withResolvers<void>(),
		released = Promise.withResolvers<void>(),
		phases: string[] = [];
	const original = defineTask<number, Checkpoint, number>({
		name: "definition-handover",
		version: 2,
		initial: () => ({ phase: "first" }),
		phases: {
			async first(_record, runtime, ctx) {
				phases.push("original-first");
				entered.resolve();
				await released.promise;
				await runtime.commit(() => ({ status: "running", checkpoint: { phase: "second" } }), ctx);
			},
			async second() {
				phases.push("original-second");
			},
			async third() {},
		},
		async abort(_task, runtime, ctx) {
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
		},
	});
	const replacement = defineTask({
		...original.definition,
		version,
		...(version === 3
			? {
					migrate(input: unknown, _checkpoint: unknown, from: number) {
						if (typeof input !== "number") throw new Error("Task input was not numeric");
						phases.push(`migrated-${from}`);
						return { input: input + 100, checkpoint: { phase: "second" } satisfies Checkpoint };
					},
				}
			: {}),
		phases: {
			...original.definition.phases,
			async second(record, runtime, ctx) {
				phases.push("replacement-second");
				await runtime.commit(
					() => ({ status: "terminal", outcome: { status: "completed", result: record.input } }),
					ctx,
				);
			},
		},
	});
	const { session, scheduler, registry, storage, reports } = await open([original]),
		conversationId = await root(session);
	const id = await session.commit(
		(tx) => tx.createTask(original, 7, { conversationId, ownership: { kind: "conversation" } }),
		context,
	);
	try {
		scheduler.resume();
		await entered.promise;
		registry.replace([replacement]);
		released.resolve();
		expect((await scheduler.waitForTask(id, context)).state).toEqual({
			status: "terminal",
			outcome: { status: "completed", result: version === 3 ? 107 : 7 },
		});
		expect(phases).toEqual(
			version === 3 ? ["original-first", "migrated-2", "replacement-second"] : ["original-first", "replacement-second"],
		);
		expect((await storage.task(id, context))?.version).toBe(version);
		expect(reports).toEqual([]);
	} finally {
		released.resolve();
	}
});

test("blocked-state listener failures are reported without suppressing other listeners or unsubscription", async () => {
	const { scheduler, registry, reports } = await open([]);
	let received = 0;
	const failure = new Error("Listener failed");
	const removeBad = scheduler.subscribeBlocked(() => {
			throw failure;
		}),
		removeGood = scheduler.subscribeBlocked(() => received++);
	registry.replace([]);
	expect(received).toBe(1);
	expect(reports).toEqual([{ error: failure, info: { kind: "listener_error" } }]);
	removeBad();
	removeBad();
	removeGood();
	registry.replace([]);
	expect(received).toBe(1);
	expect(reports).toHaveLength(1);
});

test("unknown task waits and aborts leave the scheduler usable and close rejects later waits", async () => {
	const task = defineTask<null, { phase: "run" }, null>({
		name: "lookup-survival",
		version: 1,
		initial: () => ({ phase: "run" }),
		phases: {
			async run(_record, runtime, ctx) {
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx);
			},
		},
		async abort() {},
	});
	const { session, scheduler } = await open([task]),
		conversationId = await root(session),
		missing = idFromNumber<TaskId>(100000);
	await expect(scheduler.waitForTask(missing, context)).rejects.toThrow(/does not exist/);
	await expect(scheduler.abort(missing, context)).rejects.toThrow(/does not exist/);
	const id = await session.commit(
		(tx) => tx.createTask(task, null, { conversationId, ownership: { kind: "conversation" } }),
		context,
	);
	scheduler.resume();
	expect((await scheduler.waitForTask(id, context)).state).toMatchObject({
		status: "terminal",
		outcome: { status: "completed" },
	});
	await session.close(context);
	await expect(scheduler.waitForTask(id, context)).rejects.toThrow(/closed/);
	await expect(scheduler.waitForIdle(undefined, context)).rejects.toThrow(/closed/);
});

test("an unsuccessful migration after a live handover stays blocked until a compatible definition returns", async () => {
	const entered = Promise.withResolvers<void>(),
		released = Promise.withResolvers<void>();
	let migrated = 0;
	const original = defineTask<null, Checkpoint, null>({
		name: "handover-recovery",
		version: 1,
		initial: () => ({ phase: "first" }),
		phases: {
			async first(_record, runtime, ctx) {
				entered.resolve();
				await released.promise;
				await runtime.commit(() => ({ status: "running", checkpoint: { phase: "second" } }), ctx);
			},
			async second(_record, runtime, ctx) {
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx);
			},
			async third() {},
		},
		async abort() {},
	});
	const replacement = defineTask({
		...original.definition,
		version: 2,
		migrate() {
			migrated++;
			throw new Error("Cannot migrate checkpoint");
		},
	});
	const { session, scheduler, registry } = await open([original]),
		conversationId = await root(session);
	const id = await session.commit(
		(tx) => tx.createTask(original, null, { conversationId, ownership: { kind: "conversation" } }),
		context,
	);
	try {
		scheduler.resume();
		await entered.promise;
		registry.replace([replacement]);
		released.resolve();
		await vi.waitFor(async () =>
			expect((await scheduler.inspect(registry.snapshot())).tasks).toMatchObject([
				{ record: { id }, state: { kind: "blocked", reason: "migration_failed" } },
			]),
		);
		expect(migrated).toBe(1);
		registry.replace([original]);
		expect((await scheduler.waitForTask(id, context)).state).toMatchObject({
			status: "terminal",
			outcome: { status: "completed" },
		});
	} finally {
		released.resolve();
	}
});
