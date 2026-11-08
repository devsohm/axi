import { expect, test } from "vitest";
import { BACKGROUND_CONTEXT as context } from "@axi/objects/context";
import { createSession, defineEntry, defineTask, MemoryStorage, ReadAfterWrite, type TaskId } from "../src/index.ts";

const Work = defineTask<null, { phase: "finish" }, null>({
	name: "boundary-work",
	version: 1,
	initial: () => ({ phase: "finish" }),
	phases: {
		finish: async (_task, runtime, call) => {
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), call);
		},
	},
	abort: async (_task, runtime, call) => {
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), call);
	},
});

test("transaction queries paginate committed conversations and entries and enforce typed entry kinds", async () => {
	const session = createSession(new MemoryStorage());
	try {
		const saved = await session.commit(async (tx) => {
			const first = await tx.createConversation({ ownership: { kind: "ownerless" } });
			const second = await tx.createConversation({ ownership: { kind: "ownerless" } });
			const one = await tx.appendEntry(first.id, { kind: "note", data: { position: 1 } });
			const two = await tx.appendEntry(first.id, { kind: "note", data: { position: 2 }, head: "self" });
			return { first, second, one, two };
		}, context);
		await session.commit(async (tx) => {
			const conversations = await tx.scanConversations({ order: "descending" }, 1);
			expect(conversations.items.map((row) => row.id)).toEqual([saved.second.id]);
			expect(
				(await tx.scanConversations({ order: "descending" }, 1, conversations.next)).items.map((row) => row.id),
			).toEqual([saved.first.id]);
			const entries = await tx.scanEntries({ conversationId: saved.first.id, order: "ascending" }, 1);
			expect(entries.items).toEqual([saved.one]);
			expect(
				(await tx.scanEntries({ conversationId: saved.first.id, order: "ascending" }, 1, entries.next)).items,
			).toEqual([saved.two]);
			expect(
				(
					await tx.scanEntries(
						{ conversationId: saved.first.id, minEntryId: saved.two.id, maxEntryId: saved.two.id },
						10,
					)
				).items,
			).toEqual([saved.two]);
			expect(await tx.entry(saved.one.id)).toEqual(saved.one);
			expect(await tx.entry(defineEntry("other"), saved.one.id)).toBeUndefined();
			expect(await tx.entry(defineEntry("note"), saved.one.id)).toEqual(saved.one);
		}, context);
		await expect(
			session.commit(async (tx) => {
				await tx.appendEntry(saved.first.id, { kind: "discarded" });
				await tx.scanEntries({ conversationId: saved.first.id }, 10);
			}, context),
		).rejects.toBeInstanceOf(ReadAfterWrite);
		await session.commit(async (tx) => {
			expect((await tx.scanEntries({ conversationId: saved.first.id, order: "ascending" }, 10)).items).toEqual([
				saved.one,
				saved.two,
			]);
		}, context);
	} finally {
		await session.close(context);
	}
});

test("task admission rejects missing owners and mismatched child settings without committing partial work", async () => {
	const storage = new MemoryStorage();
	const session = createSession(storage);
	try {
		const saved = await session.commit(async (tx) => {
			const first = await tx.createConversation({ ownership: { kind: "ownerless" } });
			const second = await tx.createConversation({ ownership: { kind: "ownerless" } });
			const parent = await tx.createTask(Work, null, { ownership: { kind: "conversation" }, conversationId: first.id });
			return { first, second, parent };
		}, context);
		const missing = await storage.mintId<TaskId>();
		await expect(
			session.commit((tx) => tx.createConversation({ ownership: { kind: "task", taskId: missing } }), context),
		).rejects.toThrow("does not exist");
		await expect(
			session.commit((tx) => tx.createTask(Work, null, { ownership: { kind: "task", taskId: missing } }), context),
		).rejects.toThrow("does not exist");
		await expect(
			session.commit((tx) => tx.createTask(Work, null, { ownership: { kind: "conversation" } }), context),
		).rejects.toThrow("conversationId");
		await expect(
			session.commit(
				(tx) => tx.createTask(Work, null, { ownership: { kind: "task", taskId: saved.parent }, background: true }),
				context,
			),
		).rejects.toThrow("cannot be background");
		await expect(
			session.commit(
				(tx) =>
					tx.createTask(Work, null, {
						ownership: { kind: "task", taskId: saved.parent },
						conversationId: saved.second.id,
					}),
				context,
			),
		).rejects.toThrow("owner's conversation");
		const child = await session.commit(
			(tx) => tx.createTask(Work, null, { ownership: { kind: "task", taskId: saved.parent } }),
			context,
		);
		await session.commit(async (tx) => {
			const tasks = await tx.scanTasks({ conversationId: saved.first.id }, 10);
			expect(tasks.items.map((task) => task.id)).toEqual([saved.parent, child]);
			expect(tasks.items[1]).toMatchObject({
				owner: saved.parent,
				conversationId: saved.first.id,
				state: { status: "pending" },
			});
		}, context);
	} finally {
		await session.close(context);
	}
});
