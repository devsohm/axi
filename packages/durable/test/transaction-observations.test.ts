import { BACKGROUND_CONTEXT as context } from "@axi/objects/context";
import { expect, test } from "vitest";
import { type DocumentCommitChange, createSession, defineDocFamily, defineTask, MemoryStorage } from "../src/index.ts";

test("transaction records and observer publications retain their observable shape", async () => {
	const storage = new MemoryStorage();
	const session = createSession(storage);
	const counters = defineDocFamily({
		kind: "counters",
		scope: "session",
		family: true,
		version: 1,
		initial: (value: number) => ({ value }),
		checkpointWhen: () => false,
	});
	const work = defineTask<null, { phase: "start" }, null>({
		name: "work",
		version: 1,
		initial: () => ({ phase: "start" }),
		phases: { start: async () => {} },
		abort: async () => {},
	});
	const publications: DocumentCommitChange[] = [];
	session.observeCommits({
		advance: (publication) => {
			for (const change of publication.changes) if (change.type === "document") publications.push(change);
		},
		end: () => {},
	});
	try {
		const { submission, task } = await session.commit(async (tx) => {
			const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
			const submission = await tx.createSubmission({
				conversationId: conversation.id,
				type: "input",
				status: "queued",
			});
			const task = await tx.createTask(work, null, {
				conversationId: conversation.id,
				ownership: { kind: "conversation" },
				trace: { traceparent: "current" },
				links: [{ traceparent: "parent" }],
			});
			await tx.doc(counters, "first", 1);
			return { submission, task };
		}, context);
		const answer = await session.commit((tx) => tx.appendEntry(submission.conversationId, { kind: "answer" }), context);
		let rejection: unknown;
		try {
			await session.commit((tx) => tx.settleSubmission(submission.id, { status: "done", answer: answer.id }), context);
		} catch (error) {
			rejection = error;
		}
		await session.commit((tx) => tx.doc(counters, "second", 2), context);
		const [first, second] = publications;
		if (
			first?.type !== "document" ||
			first.kind !== "change" ||
			second?.type !== "document" ||
			second.kind !== "change"
		)
			throw new Error("Document creation was not published");
		const record = await storage.task(task, context);
		if (!record) throw new Error("The task record is missing");
		expect({
			error: rejection instanceof Error ? rejection.message : rejection,
			status: (await storage.submission(submission.id, context))?.status,
			sharedOperations: first.ops === second.ops,
			keys: Object.keys(record),
		}).toEqual({
			error: `Submission ${submission.id} is not a placed input or continue`,
			status: "queued",
			sharedOperations: true,
			keys: [
				"id",
				"conversationId",
				"kind",
				"version",
				"input",
				"trace",
				"links",
				"background",
				"abortRequested",
				"state",
			],
		});
	} finally {
		await session.close(context);
	}
});
