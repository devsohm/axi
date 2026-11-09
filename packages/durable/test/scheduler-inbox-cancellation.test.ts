import { BACKGROUND_CONTEXT as context, awaitWithContext } from "@axi/objects/context";
import { afterEach, expect, test, vi } from "vitest";
import { defineTask, type ConversationId, type Tx } from "../src/index.ts";
import { InboxDoc } from "../src/harness/inbox.ts";
import { closeSchedulers, open, root } from "./scheduler-support.ts";

afterEach(closeSchedulers);

async function queue(tx: Tx, conversationId: ConversationId, mode: "steer" | "followUp") {
	const input = await tx.createSubmission({ type: "input", conversationId, status: "queued" });
	(await tx.doc(InboxDoc, conversationId)).items.push({ id: input.id, mode, content: "queued input" });
	return input;
}

test.each(["steer", "followUp"] as const)(
	"conversation abort withdraws %s inputs while retaining queued writes and unrelated inputs",
	async (mode) => {
		const { session, scheduler, storage } = await open([]);
		const conversationId = await root(session),
			unrelated = await root(session);
		const queued = await session.commit(async (tx) => {
			const input = await queue(tx, conversationId, mode);
			const other = await queue(tx, unrelated, mode);
			const write = await tx.createSubmission({ type: "write", conversationId, status: "queued" });
			(await tx.doc(InboxDoc, conversationId)).items.push({ id: write.id, mode: "write", entry: { kind: "retained" } });
			return { input, other, write };
		}, context);
		await scheduler.abortConversation(conversationId, false, context);
		await scheduler.abortConversation(conversationId, false, context);
		expect(await storage.submission(queued.input.id, context)).toMatchObject({
			status: "unanswered",
			reason: "aborted",
		});
		expect(await storage.submission(queued.other.id, context)).toMatchObject({ status: "queued" });
		expect(await storage.submission(queued.write.id, context)).toMatchObject({ status: "queued" });
		expect(await session.snapshot(InboxDoc, conversationId, context)).toEqual({
			items: [{ id: queued.write.id, mode: "write", entry: { kind: "retained" } }],
		});
		expect(await session.snapshot(InboxDoc, unrelated, context)).toEqual({
			items: [{ id: queued.other.id, mode, content: "queued input" }],
		});
	},
);

test("queued inputs in task-owned conversations follow their owner's foreground or background abort scope", async () => {
	const release = Promise.withResolvers<void>();
	const started: string[] = [],
		aborted: string[] = [];
	const Owner = defineTask<string, { phase: "run" }, null>({
		name: "queued-input-owner",
		version: 1,
		initial: () => ({ phase: "run" }),
		phases: {
			async run(record, runtime, ctx) {
				started.push(record.input);
				await awaitWithContext(release.promise, ctx);
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx);
			},
		},
		async abort(record, runtime, ctx) {
			aborted.push(record.input);
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
		},
	});
	const { session, scheduler, storage } = await open([Owner]);
	const conversationId = await root(session),
		unrelated = await root(session);
	const children = await session.commit(async (tx) => {
		const foreground = await tx.createTask(Owner, "foreground", {
			conversationId,
			ownership: { kind: "conversation" },
		});
		const background = await tx.createTask(Owner, "background", {
			conversationId,
			ownership: { kind: "conversation" },
			background: true,
		});
		const child = await tx.createConversation({ ownership: { kind: "task", taskId: foreground } });
		const backgroundChild = await tx.createConversation({ ownership: { kind: "task", taskId: background } });
		return { foreground, background, child: child.id, backgroundChild: backgroundChild.id };
	}, context);
	try {
		scheduler.resume();
		await vi.waitFor(() => expect(started.length).toBe(2));
		const inputs = await session.commit(
			async (tx) => ({
				root: await queue(tx, conversationId, "steer"),
				child: await queue(tx, children.child, "followUp"),
				background: await queue(tx, children.backgroundChild, "followUp"),
				unrelated: await queue(tx, unrelated, "steer"),
			}),
			context,
		);
		await scheduler.abortConversation(conversationId, false, context);
		for (const input of [inputs.root, inputs.child]) {
			expect(await storage.submission(input.id, context)).toMatchObject({ status: "unanswered", reason: "aborted" });
		}
		for (const input of [inputs.background, inputs.unrelated]) {
			expect(await storage.submission(input.id, context)).toMatchObject({ status: "queued" });
		}
		expect(aborted).toEqual(["foreground"]);
		expect((await storage.task(children.background, context))?.state.status).toBe("running");
		await scheduler.abortConversation(conversationId, true, context);
		expect(await storage.submission(inputs.background.id, context)).toMatchObject({
			status: "unanswered",
			reason: "aborted",
		});
		expect(await storage.submission(inputs.unrelated.id, context)).toMatchObject({ status: "queued" });
		expect(aborted).toEqual(["foreground", "background"]);
		for (const id of [children.foreground, children.background]) {
			expect((await scheduler.waitForTask(id, context)).state).toEqual({
				status: "terminal",
				outcome: { status: "aborted" },
			});
		}
	} finally {
		release.resolve();
	}
});
