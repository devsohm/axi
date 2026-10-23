import { createModels } from "@axi/ai";
import { BACKGROUND_CONTEXT as context } from "@axi/chord/context";
import { expect, it } from "vitest";
import {
	createRegistry,
	Harness,
	MemoryStorage,
	ReadOnlySession,
	ROOT_CONVERSATION_ID,
	type TaskId,
} from "../src/index.ts";
import { idFromNumber } from "../src/ids.ts";

it("reads live records without recovering, writing or emitting scheduling notifications", async () => {
	const storage = new MemoryStorage();
	const id = idFromNumber<TaskId<null>>(2);
	await storage.commit(
		[
			{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } },
			{
				type: "task",
				value: {
					id,
					conversationId: ROOT_CONVERSATION_ID,
					kind: "unavailable",
					version: 1,
					input: null,
					background: false,
					abortRequested: false,
					abandonOnRestart: true,
					state: { status: "running", checkpoint: { phase: "wait" } },
				},
			},
		],
		() => {},
		context,
	);
	const wakes: unknown[] = [],
		reports: unknown[] = [];
	const harness = await Harness.open(
		storage,
		{
			models: createModels(),
			registry: createRegistry(),
			readOnly: true,
			onWake: (value) => wakes.push(value),
			onReport: (error) => reports.push(error),
		},
		context,
	);
	try {
		const root = await harness.root(context);
		expect((await harness.getTask(id, context))?.state.status).toBe("running");
		expect((await harness.getTask(id, context))?.restarts).toBeUndefined();
		expect((await harness.inspect(context)).scheduling).toBe("paused");
		expect(harness.wake()).toEqual({ active: false });
		expect(() => harness.resume()).toThrow(ReadOnlySession);
		await expect(harness.waitForIdle(context)).rejects.toBeInstanceOf(ReadOnlySession);
		await expect(root.abort(context)).rejects.toBeInstanceOf(ReadOnlySession);
		await expect(root.commit((tx) => tx.appendEntry(root.id, { kind: "note" }), context)).rejects.toBeInstanceOf(
			ReadOnlySession,
		);
		await expect(harness.createConversation({ ownership: { kind: "ownerless" } }, context)).rejects.toBeInstanceOf(
			ReadOnlySession,
		);
		await expect(root.commit(() => 42, context)).resolves.toBe(42);
		expect(wakes).toEqual([]);
		expect(reports).toEqual([]);
	} finally {
		await harness.close(context);
	}
});
it("refuses root creation in empty storage without failing reads", async () => {
	const harness = await Harness.open(
		new MemoryStorage(),
		{ models: createModels(), registry: createRegistry(), readOnly: true },
		context,
	);
	try {
		await expect(harness.root(context)).rejects.toBeInstanceOf(ReadOnlySession);
		expect((await harness.inspect(context)).scheduling).toBe("paused");
	} finally {
		await harness.close(context);
	}
});
