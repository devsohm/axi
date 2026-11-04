import { commitWrites } from "../src/testing/commit-writes.ts";
import { createModels } from "@axi/ai";
import type { Context } from "@axi/objects";
import { BACKGROUND_CONTEXT as context } from "@axi/objects/context";
import { expect, it } from "vitest";
import { idFromNumber } from "../src/ids.ts";
import { createRegistry, Harness, MemoryStorage, ROOT_CONVERSATION_ID, type TaskId } from "../src/index.ts";

it("fails closed when a recovered wait member cannot be read", async () => {
	class Storage extends MemoryStorage {
		override async task(id: TaskId, ctx: Context) {
			if (id === 3) throw new Error("Later task receipt is unavailable");
			return super.task(id, ctx);
		}
	}
	const storage = new Storage();
	const parent = idFromNumber<TaskId<null>>(4);
	const fields = {
		conversationId: ROOT_CONVERSATION_ID,
		kind: "recovering",
		version: 1,
		input: null,
		background: false,
		abortRequested: false,
	};
	await commitWrites(
		storage,
		[
			{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } },
			{
				type: "task",
				value: {
					...fields,
					id: idFromNumber<TaskId<null>>(2),
					owner: parent,
					state: { status: "terminal", outcome: { status: "failed", error: { message: "Failed" } } },
				},
			},
			{
				type: "task",
				value: {
					...fields,
					id: idFromNumber<TaskId<null>>(3),
					owner: parent,
					state: { status: "terminal", outcome: { status: "completed", result: null } },
				},
			},
			{
				type: "task",
				value: {
					...fields,
					id: parent,
					state: {
						status: "waiting",
						checkpoint: { phase: "hold" },
						on: [idFromNumber<TaskId>(2), idFromNumber<TaskId>(3)],
						policy: "failFast",
					},
				},
			},
		],
		context,
	);
	const harness = await Harness.open(storage, { models: createModels(), registry: createRegistry() }, context);
	try {
		await expect(harness.inspect(context)).rejects.toThrow("Session failed after a storage error");
	} finally {
		await harness.close(context);
	}
});
