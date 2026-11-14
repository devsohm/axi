import { BACKGROUND_CONTEXT as context } from "@axi/objects/context";
import { afterEach, expect, test, vi } from "vitest";
import { defineTask, type TaskRuntime } from "../src/index.ts";
import { closeSchedulers, open, root } from "./scheduler-support.ts";

afterEach(closeSchedulers);

test("a rejected agent lookup stays local to its invocation and expires when that task ends", async () => {
	const failure = new Error("Agent configuration unavailable");
	let lookups = 0,
		captured: TaskRuntime<null, { phase: "read" }, null, object> | undefined;
	const Read = defineTask<null, { phase: "read" }, null>({
		name: "agent-reader",
		version: 1,
		initial: () => ({ phase: "read" }),
		phases: {
			async read(_record, runtime, ctx) {
				captured = runtime;
				await expect(runtime.agent(ctx)).rejects.toBe(failure);
				await expect(runtime.agent(ctx)).rejects.toBe(failure);
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx);
			},
		},
		abort: (_record, runtime, ctx) =>
			runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
	});
	const { session, scheduler } = await open([Read], {
		agent: async () => {
			lookups++;
			throw failure;
		},
	});
	const conversationId = await root(session);
	const id = await session.commit(
		(tx) => tx.createTask(Read, null, { conversationId, ownership: { kind: "conversation" } }),
		context,
	);
	scheduler.resume();
	expect((await scheduler.waitForTask(id, context)).state.outcome).toEqual({ status: "completed", result: null });
	await vi.waitFor(() => expect(captured?.signal.aborted).toBe(true));
	if (!captured) throw new Error("The task did not receive its runtime");
	await expect(captured.agent(context)).rejects.toThrow("invocation has ended");
	expect(lookups).toBe(1);
});
