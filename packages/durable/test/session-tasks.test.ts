import { BACKGROUND_CONTEXT as context } from "@axi/chord/context";
import { describe, expect, it } from "vitest";
import { defineDoc, defineDocFamily, defineTask, MemoryStorage, type TaskId } from "../src/index.ts";
import { SessionImpl } from "../src/session/session.ts";

const Work = defineTask<null, { phase: "start" }, null>({
	name: "work",
	version: 1,
	initial: () => ({ phase: "start" }),
	phases: { start: async () => {} },
	abort: async () => {},
});
const Progress = defineDoc({ kind: "progress", version: 1, scope: "task", initial: () => ({ count: 0 }) });

describe("task creation transactions", () => {
	it("retires all documents of multiple settled tasks without retiring live work", async () => {
		const storage = new MemoryStorage();
		const session = new SessionImpl(storage);
		const Parts = defineDocFamily({
			kind: "parts",
			version: 1,
			scope: "task",
			family: true,
			initial: (count: number) => ({ count }),
		});
		try {
			const ids = await session.commit(async (tx) => {
				const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
				const ids: TaskId<null>[] = [];
				for (let index = 0; index < 3; index++) {
					const id = await tx.createTask(Work, null, {
						ownership: { kind: "conversation" },
						conversationId: conversation.id,
					});
					(await tx.doc(Progress, id)).count = index;
					ids.push(id);
				}
				for (let index = 0; index < 260; index++) await tx.doc(Parts, ids[0]!, String(index), index);
				return ids;
			}, context);
			await session.commitWith(async (tx) => {
				const records = await Promise.all(ids.slice(0, 2).map((id) => tx.task(id)));
				(await tx.doc(Parts, ids[0]!, "0", 0)).count = 999;
				(await tx.doc(Progress, ids[1]!)).count = 999;
				for (const record of records)
					tx.setTask({
						...record!,
						memos: undefined,
						state: { status: "terminal", outcome: { status: "completed", result: null } },
					});
			}, context);
			for (const id of ids.slice(0, 2)) {
				const documents = await storage.scanDocuments(
					{ scope: { kind: "task", taskId: id }, at: "current" },
					300,
					undefined,
					context,
				);
				expect(documents).toEqual({ items: [] });
				expect((await storage.task(id, context))?.state).toEqual({
					status: "terminal",
					outcome: { status: "completed", result: null },
				});
			}
			expect(await session.snapshot(Progress, ids[2]!, context)).toEqual({ count: 2 });
			expect((await storage.task(ids[2]!, context))?.state.status).toBe("pending");
		} finally {
			await session.close(context);
		}
	});
	it("creates a child and its document atomically with its owner", async () => {
		const storage = new MemoryStorage();
		const session = new SessionImpl(storage);
		const { parent, child, conversation } = await session.commit(async (tx) => {
			const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
			const parent = await tx.createTask(Work, null, {
				ownership: { kind: "conversation" },
				conversationId: conversation.id,
			});
			const child = await tx.createTask(Work, null, { ownership: { kind: "task", taskId: parent } });
			(await tx.doc(Progress, child)).count = 3;
			return { parent, child, conversation };
		}, context);
		expect(await storage.task(child, context)).toEqual({
			id: child,
			owner: parent,
			conversationId: conversation.id,
			kind: "work",
			version: 1,
			input: null,
			background: false,
			abortRequested: false,
			state: { status: "pending", checkpoint: { phase: "start" } },
		});
		expect(await session.snapshot(Progress, child, context)).toEqual({ count: 3 });
		await session.close(context);
	});
	it("rejects child creation when its owner's final candidate is cancelled", async () => {
		const storage = new MemoryStorage();
		const session = new SessionImpl(storage);
		const conversation = await session.commit(
			(tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
			context,
		);
		const parent = await session.commit(
			(tx) =>
				tx.createTask(Work, null, {
					ownership: { kind: "conversation" },
					conversationId: conversation.id,
				}),
			context,
		);
		let child: TaskId | undefined;
		await expect(
			session.commitWith(async (tx) => {
				const owner = (await tx.task(parent))!;
				child = await tx.createTask(Work, null, { ownership: { kind: "task", taskId: parent } });
				tx.setTask({ ...owner, abortRequested: true });
			}, context),
		).rejects.toThrow(`Task owner ${parent} is abort-marked`);
		expect(child).toBeDefined();
		expect(await storage.task(child!, context)).toBeUndefined();
		expect((await storage.task(parent, context))?.abortRequested).toBe(false);
		await session.close(context);
	});
	it("retires a newly created task's documents when the same commit finishes it", async () => {
		const storage = new MemoryStorage();
		const session = new SessionImpl(storage);
		const conversation = await session.commit(
			(tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
			context,
		);
		const id = await session.commitWith(async (tx) => {
			const id = await tx.createTask(Work, null, {
				ownership: { kind: "conversation" },
				conversationId: conversation.id,
			});
			await tx.doc(Progress, id);
			tx.setTask({
				id,
				conversationId: conversation.id,
				kind: "work",
				version: 1,
				input: null,
				background: false,
				abortRequested: false,
				state: { status: "terminal", outcome: { status: "completed", result: null } },
			});
			return id;
		}, context);
		expect((await storage.task(id, context))?.state).toEqual({
			status: "terminal",
			outcome: { status: "completed", result: null },
		});
		expect(await session.snapshot(Progress, id, context)).toBeUndefined();
		await session.close(context);
	});
});
