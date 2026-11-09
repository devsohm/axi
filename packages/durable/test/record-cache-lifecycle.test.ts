import { BACKGROUND_CONTEXT as context } from "@axi/objects/context";
import { expect, test, vi } from "vitest";
import { MemoryStorage, type ConversationId, type StorageWrite, type TaskId } from "../src/index.ts";
import { CachedStorage } from "../src/session/cached-storage.ts";

type Task = Extract<StorageWrite, { type: "task" }>["value"];
async function fixture() {
	const storage = new MemoryStorage();
	const cached = new CachedStorage(storage);
	const conversationId = await storage.mintId<ConversationId>();
	const records: Task[] = [];
	for (let index = 0; index < 3; index++)
		records.push({
			id: await storage.mintId<Task["id"]>(),
			conversationId,
			kind: "cache-work",
			version: 1,
			input: null,
			background: false,
			abortRequested: false,
			state: { status: "pending", checkpoint: { phase: "start" } },
		});
	await storage.commit(
		[
			[
				{ type: "conversation", value: { id: conversationId } },
				...records.map((value) => ({ type: "task" as const, value })),
			],
		],
		() => {},
		context,
	);
	return {
		storage,
		cached,
		conversationId,
		records,
		async publish(writes: readonly StorageWrite[]) {
			const result = await cached.commit([writes], () => cached.published(writes), context);
			expect(result).toEqual({ stored: 1 });
		},
		async [Symbol.asyncDispose]() {
			await cached.close(context);
		},
	};
}
function record(records: readonly Task[], index: number): Task {
	const value = records[index];
	if (!value) throw new Error(`Missing fixture task ${index}`);
	return value;
}
function ended(value: Task): Task {
	const { memos: _memos, ...rest } = value;
	return { ...rest, state: { status: "terminal", outcome: { status: "completed", result: null } } };
}

test("concurrent stale task reads cannot replace a newly published record", async () => {
	await using app = await fixture();
	const before = record(app.records, 0);
	const read = app.storage.task.bind(app.storage);
	const entered = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	let arrivals = 0;
	vi.spyOn(app.storage, "task").mockImplementation(async (...args) => {
		const value = await read(...args);
		if (++arrivals === 2) entered.resolve();
		await release.promise;
		return value;
	});
	const first = app.cached.task(before.id, context),
		second = app.cached.task(before.id, context);
	try {
		await entered.promise;
		expect(app.cached.readsInFlight).toBe(1);
		const latest: Task = { ...before, state: { status: "running", checkpoint: { phase: "next", count: 7 } } };
		await app.publish([{ type: "task", value: latest }]);
		release.resolve();
		expect(await Promise.all([first, second])).toEqual([before, before]);
		expect(await app.cached.task(before.id, context)).toEqual(latest);
		expect(Object.isFrozen(latest.state)).toBe(true);
		expect(app.cached.readsInFlight).toBe(0);
	} finally {
		release.resolve();
		await Promise.allSettled([first, second]);
	}
});

test("a concurrent absent conversation read cannot hide a committed conversation", async () => {
	await using app = await fixture();
	const id = await app.storage.mintId<ConversationId>();
	const read = app.storage.conversation.bind(app.storage);
	const entered = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	vi.spyOn(app.storage, "conversation").mockImplementationOnce(async (...args) => {
		const value = await read(...args);
		entered.resolve();
		await release.promise;
		return value;
	});
	const pending = app.cached.conversation(id, context);
	try {
		await entered.promise;
		await app.publish([{ type: "conversation", value: { id } }]);
		release.resolve();
		expect(await pending).toBeUndefined();
		expect(await app.cached.conversation(id, context)).toEqual({ id });
		expect(app.cached.readsInFlight).toBe(0);
	} finally {
		release.resolve();
		await pending;
	}
});

test("failed cache reads release their accounting and permit a successful retry", async () => {
	await using app = await fixture();
	const failure = new Error("record read failed");
	vi.spyOn(app.storage, "conversation").mockRejectedValueOnce(failure);
	await expect(app.cached.conversation(app.conversationId, context)).rejects.toBe(failure);
	expect(app.cached.readsInFlight).toBe(0);
	expect(await app.cached.conversation(app.conversationId, context)).toEqual({ id: app.conversationId });
	expect(app.cached.sizes.conversations).toBe(1);
});

test("shared task dependencies stay readable through terminal-cache eviction and both waiter resumptions", async () => {
	await using app = await fixture();
	const first = record(app.records, 0),
		second = record(app.records, 1),
		child = record(app.records, 2);
	const waiting = (task: Task): Task => ({
		...task,
		state: {
			status: "waiting",
			checkpoint: { phase: "join" },
			on: [child.id],
			policy: "allSettled",
		},
	});
	await app.publish([{ type: "task", value: ended(child) }]);
	await app.publish([first, second].map((value) => ({ type: "task", value: waiting(value) })));
	const spill: StorageWrite[] = [];
	for (let index = 0; index < 257; index++)
		spill.push({
			type: "task",
			value: ended({ ...child, id: await app.storage.mintId<Task["id"]>() }),
		});
	await app.publish(spill);
	const reads = vi.spyOn(app.storage, "task");
	expect((await app.cached.task(child.id, context))?.state).toEqual(ended(child).state);
	expect(reads).not.toHaveBeenCalled();
	expect(app.cached.sizes).toMatchObject({ tasks: 256, awaited: 1, waits: 2 });
	const resumed: Task = { ...first, state: { status: "running", checkpoint: { phase: "join" } } };
	await app.publish([{ type: "task", value: resumed }]);
	expect(app.cached.sizes.waits).toBe(2);
	await app.publish([
		{ type: "task", value: { ...resumed, state: { status: "running", checkpoint: { phase: "finish" } } } },
	]);
	expect(app.cached.sizes).toMatchObject({ awaited: 1, waits: 1 });
	await app.publish([{ type: "task", value: ended(second) }]);
	expect(app.cached.sizes).toMatchObject({ tasks: 256, awaited: 0, waits: 0 });
	expect((await app.cached.task(child.id, context))?.state.status).toBe("terminal");
	expect(reads).not.toHaveBeenCalled();
});

test("replacing a wait set releases the old dependency and retains its new target", async () => {
	await using app = await fixture();
	const first = record(app.records, 0),
		old = record(app.records, 1),
		next = record(app.records, 2);
	const waiting = (on: TaskId): Task => ({
		...first,
		state: {
			status: "waiting",
			checkpoint: { phase: "join" },
			on: [on],
			policy: "failFast",
		},
	});
	await app.publish([{ type: "task", value: waiting(old.id) }]);
	await app.publish([{ type: "task", value: waiting(next.id) }]);
	expect(app.cached.sizes).toMatchObject({ awaited: 1, waits: 1 });
	await app.publish([
		{ type: "task", value: ended(next) },
		{ type: "task", value: ended(first) },
	]);
	expect(app.cached.sizes).toMatchObject({ awaited: 0, waits: 0 });
	expect((await app.cached.task(old.id, context))?.state.status).toBe("pending");
	expect((await app.cached.task(next.id, context))?.state.status).toBe("terminal");
});
