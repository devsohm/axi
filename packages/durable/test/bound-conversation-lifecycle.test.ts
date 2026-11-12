import { createModels } from "@axi/ai";
import { BACKGROUND_CONTEXT as context } from "@axi/objects/context";
import { expect, test, vi } from "vitest";
import {
	createRegistry,
	defineTask,
	Harness,
	MemoryStorage,
	type ConversationHandle,
	type Submission,
	type SubmissionId,
} from "../src/index.ts";

test("conversation and submission handles retain authority only during the owning invocation", async () => {
	let captured:
		| { handle: ConversationHandle; submission: Submission; write: SubmissionId; signal: AbortSignal }
		| undefined;
	const task = defineTask<null, { phase: "run" }, null>({
		name: "bound-conversation-controls",
		version: 1,
		initial: () => ({ phase: "run" }),
		phases: {
			async run(_record, runtime, ctx) {
				const handle = await runtime.conversation(runtime.conversationId, ctx);
				if (!handle) throw new Error("The invocation conversation is missing");
				const submission = await handle.submit(
					{
						type: "write",
						entry: { kind: "bound-initial", data: { visible: true } },
					},
					ctx,
				);
				expect(await submission.status(ctx)).toMatchObject({ type: "write", status: "done" });
				expect(await submission.abort(ctx)).toBe("settled");
				expect(await submission.wait(ctx)).toMatchObject({ type: "write", status: "done" });
				let write: SubmissionId | undefined;
				await runtime.commit(async (tx) => {
					write = await handle.submit(tx, { type: "write", entry: { kind: "bound-write", data: { saved: true } } });
				}, ctx);
				if (write === undefined) throw new Error("The write was not admitted");
				captured = { handle, submission, write, signal: runtime.signal };
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx);
			},
		},
		abort: async (_record, runtime, ctx) => {
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
		},
	});
	const registry = createRegistry();
	registry.install({ name: "bound-controls", tasks: [task] });
	const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry }, context);
	try {
		const root = await harness.root(context);
		const id = await harness.commit(
			(tx) =>
				tx.createTask(task, null, {
					ownership: { kind: "conversation" },
					conversationId: root.id,
				}),
			context,
		);
		expect((await harness.waitForTask(id, context)).state).toMatchObject({
			status: "terminal",
			outcome: { status: "completed" },
		});
		await harness.waitForIdle(context);
		await vi.waitFor(() => expect(captured?.signal.aborted).toBe(true));
		if (!captured) throw new Error("The task did not expose its handles");
		const { handle, submission, write } = captured;
		for (const call of [
			() => submission.status(context),
			() => submission.wait(context),
			() => submission.abort(context),
			() => handle.submit({ type: "write", entry: { kind: "late-write" } }, context),
			() => handle.abort(context),
			() => handle.waitForIdle(context),
		])
			await expect(call()).rejects.toThrow(/ended/);
		await expect(
			harness.commit(
				(tx) =>
					handle.submit(tx, {
						type: "write",
						entry: { kind: "late-transaction" },
					}),
				context,
			),
		).rejects.toThrow(/ended/);
		const admitted = await harness.submission(write, context);
		if (!admitted) throw new Error("The committed write was lost");
		expect(await admitted.status(context)).toMatchObject({ type: "write", status: "done" });
		expect((await root.entries({ order: "ascending" }, 100, undefined, context)).items).toMatchObject([
			{ kind: "bound-initial", data: { visible: true } },
			{ kind: "bound-write", data: { saved: true } },
		]);
	} finally {
		await harness.close(context);
	}
});
