import { BACKGROUND_CONTEXT as context, awaitWithContext } from "@axi/objects/context";
import { afterEach, expect, test, vi } from "vitest";
import { defineDoc, defineEntry, defineTask, type EntryRecord, type TaskId, type TaskRuntime } from "../src/index.ts";
import { idFromNumber } from "../src/ids.ts";
import { closeSchedulers, open, root } from "./scheduler-support.ts";

afterEach(closeSchedulers);

test("a task can inspect and abort its children without acquiring authority over unrelated tasks", async () => {
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const Child = defineTask<null, { phase: "hold" }, null>({
		name: "runtime-child",
		version: 1,
		initial: () => ({ phase: "hold" }),
		phases: {
			async hold(_record, runtime, ctx) {
				started.resolve();
				await awaitWithContext(release.promise, ctx);
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx);
			},
		},
		async abort(_record, runtime, ctx) {
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
		},
	});
	const Parent = defineTask<null, { phase: "run" }, null>({
		name: "runtime-owner",
		version: 1,
		initial: () => ({ phase: "run" }),
		phases: {
			async run(record, runtime, ctx) {
				let child: TaskId | undefined;
				await runtime.commit(async (tx) => {
					child = await tx.createTask(Child, null, { ownership: { kind: "task", taskId: record.id } });
				}, ctx);
				if (child === undefined) throw new Error("Child was not created");
				await started.promise;
				expect(await runtime.ownedTasks(ctx)).toMatchObject([
					{ id: child, owner: record.id, state: { status: "running" } },
				]);
				const copy = await runtime.ownedTasks(ctx);
				copy.length = 0;
				expect(await runtime.ownedTasks(ctx)).toHaveLength(1);
				await expect(runtime.abortOwned(record.id, ctx)).rejects.toThrow("not owned");
				await expect(runtime.abortOwned(idFromNumber<TaskId>(100000), ctx)).rejects.toThrow("not owned");
				await expect(runtime.outcomes([record.id], ctx)).rejects.toThrow("not terminal");
				await runtime.abortOwned(child, ctx);
				await runtime.abortOwned(child, ctx);
				expect(await runtime.ownedTasks(ctx)).toEqual([]);
				expect(await runtime.outcomes([child], ctx)).toEqual([{ status: "aborted" }]);
				expect((await runtime.waitForTask(child, ctx)).state).toEqual({
					status: "terminal",
					outcome: { status: "aborted" },
				});
				expect((await runtime.getTask(child, ctx))?.owner).toBe(record.id);
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx);
			},
		},
		async abort() {},
	});
	const { session, scheduler } = await open([Parent, Child]);
	const conversationId = await root(session);
	const id = await session.commit(
		(tx) => tx.createTask(Parent, null, { conversationId, ownership: { kind: "conversation" } }),
		context,
	);
	try {
		scheduler.resume();
		expect((await scheduler.waitForTask(id, context)).state).toEqual({
			status: "terminal",
			outcome: { status: "completed", result: null },
		});
	} finally {
		release.resolve();
	}
});

test("task document snapshots and typed entry reads respect committed history and page boundaries", async () => {
	const State = defineDoc({
		kind: "runtime-history",
		version: 1,
		scope: "conversation",
		history: "rewindable",
		fork: "asOf",
		initial: () => ({ count: 0 }),
		checkpointWhen: () => false,
	});
	const Marker = defineEntry<{ n: number }>("runtime-marker");
	const Other = defineEntry<{ n: number }>("other-marker");
	const Task = defineTask<null, { phase: "run" }, null>({
		name: "runtime-reader",
		version: 1,
		initial: () => ({ phase: "run" }),
		phases: {
			async run(_record, runtime, ctx) {
				const conversationId = runtime.conversationId;
				expect(await runtime.watchDoc(State, conversationId, ctx)).toBeUndefined();
				let first: EntryRecord | undefined;
				await runtime.commit(async (tx) => {
					(await tx.doc(State, conversationId)).count = 1;
					first = await tx.appendEntry(conversationId, { kind: Marker.kind, data: { n: 1 } });
				}, ctx);
				if (first === undefined) throw new Error("First entry was not saved");
				const watch = await runtime.watchDoc(State, conversationId, ctx);
				if (watch === undefined) throw new Error("Document watch is absent");
				await runtime.commit(async (tx) => {
					(await tx.doc(State, conversationId)).count = 2;
					await tx.appendEntry(conversationId, { kind: Marker.kind, data: { n: 2 } });
				}, ctx);
				expect(await runtime.snapshot(State, conversationId, ctx)).toEqual({ count: 2 });
				expect(await runtime.snapshotAsOf(State, conversationId, first.id, ctx)).toEqual({ count: 1 });
				expect(await runtime.entry(first.id, ctx)).toEqual(first);
				expect(await runtime.entry(Marker, first.id, ctx)).toEqual(first);
				expect(await runtime.entry(Other, first.id, ctx)).toBeUndefined();
				const page = await runtime.entries({ order: "ascending" }, 1, undefined, ctx);
				expect(page.items).toEqual([first]);
				expect(page.next).toBeDefined();
				const rest = await runtime.entries({ order: "ascending" }, 1, page.next, ctx);
				expect(rest.items).toMatchObject([{ kind: Marker.kind, data: { n: 2 } }]);
				expect(rest.next).toBeUndefined();
				await watch.stop();
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx);
			},
		},
		async abort() {},
	});
	const { session, scheduler } = await open([Task]);
	const conversationId = await root(session);
	const id = await session.commit(
		(tx) => tx.createTask(Task, null, { conversationId, ownership: { kind: "conversation" } }),
		context,
	);
	scheduler.resume();
	expect((await scheduler.waitForTask(id, context)).state).toEqual({
		status: "terminal",
		outcome: { status: "completed", result: null },
	});
});

test("a completed invocation rejects later reads and writes and does not schedule new timers", async () => {
	let captured: TaskRuntime<null, { phase: "run" }, null, object> | undefined;
	const Task = defineTask<null, { phase: "run" }, null>({
		name: "runtime-lifetime",
		version: 1,
		initial: () => ({ phase: "run" }),
		phases: {
			async run(_record, runtime, ctx) {
				captured = runtime;
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx);
			},
		},
		async abort() {},
	});
	const State = defineDoc({
		kind: "late-runtime",
		version: 1,
		scope: "session",
		initial: () => ({ count: 0 }),
		checkpointWhen: () => false,
	});
	const { session, scheduler } = await open([Task]);
	const conversationId = await root(session);
	const id = await session.commit(
		(tx) => tx.createTask(Task, null, { conversationId, ownership: { kind: "conversation" } }),
		context,
	);
	scheduler.resume();
	await scheduler.waitForTask(id, context);
	await scheduler.waitForIdle(undefined, context);
	await vi.waitFor(() => expect(captured?.signal.aborted).toBe(true));
	if (captured === undefined) throw new Error("Runtime was not captured");
	const runtime = captured;
	for (const operation of [
		() => runtime.memo("late", context),
		() => runtime.memo("late", 1, context),
		() => runtime.getTask(id, context),
		() => runtime.waitForTask(id, context),
		() => runtime.ownedTasks(context),
		() => runtime.abortOwned(id, context),
		() => runtime.outcomes([id], context),
		() => runtime.snapshot(State, context),
		() => runtime.watchDoc(State, context),
		() => runtime.conversation(conversationId, context),
		() => runtime.entries({}, 1, undefined, context),
		() => runtime.context(conversationId, context),
		() => runtime.env(context),
		() => runtime.agent(context),
		() => runtime.commit(() => undefined, context),
		() => runtime.sleepUntil(Date.now() + 100, { phase: "run" }, context),
	])
		await expect(operation()).rejects.toThrow(/ended/);
	expect(() => runtime.now()).toThrow(/ended/);
	expect(() => runtime.report(new Error("late"))).toThrow(/ended/);
	let fired = false;
	const cancel = runtime.setTimer(() => {
		fired = true;
	}, 0);
	cancel();
	cancel();
	await new Promise<void>((resolve) => setTimeout(resolve, 5));
	expect(fired).toBe(false);
});

test.each(["wait", "sleep"] as const)(
	"an abort handler cannot %s but can still commit its terminal outcome",
	async (action) => {
		const Task = defineTask<null, { phase: "run" }, null>({
			name: "runtime-abort-controls",
			version: 1,
			initial: () => ({ phase: "run" }),
			phases: {
				async run() {
					throw new Error("Aborted work executed");
				},
			},
			async abort(record, runtime, ctx) {
				if (action === "wait")
					await expect(
						runtime.commit(
							() => ({ status: "waiting", on: [record.id], policy: "allSettled", checkpoint: { phase: "run" } }),
							ctx,
						),
					).rejects.toThrow("cannot wait");
				else await expect(runtime.sleepUntil(Date.now() + 10, { phase: "run" }, ctx)).rejects.toThrow("cannot sleep");
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
			},
		});
		const { session, scheduler } = await open([Task]);
		const conversationId = await root(session);
		const id = await session.commit(
			(tx) => tx.createTask(Task, null, { conversationId, ownership: { kind: "conversation" } }),
			context,
		);
		await scheduler.abort(id, context);
		scheduler.resume();
		expect((await scheduler.waitForTask(id, context)).state).toEqual({
			status: "terminal",
			outcome: { status: "aborted" },
		});
	},
);

test("task reports identify their source and resolve the agent only once per phase", async () => {
	let resolutions = 0;
	const failure = new Error("Adapter failure");
	const Task = defineTask<null, { phase: "run" }, null>({
		name: "runtime-reporting",
		version: 1,
		initial: () => ({ phase: "run" }),
		phases: {
			async run(_record, runtime, ctx) {
				expect(await runtime.agent(ctx)).toBe(await runtime.agent(ctx));
				expect(await runtime.env(ctx)).toBeUndefined();
				expect(await runtime.conversation(runtime.conversationId, ctx)).toBeUndefined();
				expect(runtime.now()).toBe(1234);
				runtime.report(failure);
				runtime.report(failure, { kind: "extension", extension: "custom" });
				runtime.report(failure, { kind: "host", callback: "env" });
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx);
			},
		},
		async abort() {},
	});
	const { session, scheduler, reports } = await open([Task], {
		now: () => 1234,
		agent: async () => {
			resolutions++;
			return { thinkingLevel: "off", extensions: [], tools: [], callable: [], deferred: [], sections: [] };
		},
	});
	const conversationId = await root(session);
	const id = await session.commit(
		(tx) => tx.createTask(Task, null, { conversationId, ownership: { kind: "conversation" } }),
		context,
	);
	scheduler.resume();
	expect((await scheduler.waitForTask(id, context)).state).toMatchObject({
		status: "terminal",
		outcome: { status: "completed" },
	});
	expect(resolutions).toBe(1);
	expect(reports).toMatchObject([
		{ error: failure, info: { kind: "task_error", task: { id, kind: Task.definition.name, conversationId } } },
		{
			error: failure,
			info: { kind: "extension_error", extension: "custom", task: { id, kind: Task.definition.name, conversationId } },
		},
		{
			error: failure,
			info: { kind: "host_error", callback: "env", task: { id, kind: Task.definition.name, conversationId } },
		},
	]);
});
