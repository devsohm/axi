import { defineTask } from "../../src/index.ts";

export function reviewTask(beforeFinish: () => Promise<void>) {
	return defineTask<null, { phase: "save" } | { phase: "finish" }, null>({
		name: "review.recovery",
		version: 1,
		initial: () => ({ phase: "save" }),
		phases: {
			async save(_task, runtime, context) {
				await runtime.commit(async (tx) => {
					await tx.appendEntry(runtime.conversationId, { kind: "review.checkpoint" });
					return { status: "running", checkpoint: { phase: "finish" } };
				}, context);
			},
			async finish(_task, runtime, context) {
				await beforeFinish();
				await runtime.commit(async (tx) => {
					await tx.appendEntry(runtime.conversationId, { kind: "review.finished" });
					return { status: "terminal", outcome: { status: "completed", result: null } };
				}, context);
			},
		},
		abort: (_task, runtime, context) =>
			runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
	});
}
