import { createModels } from "@axi/ai";
import { BACKGROUND_CONTEXT as context } from "@axi/objects/context";
import { expect, test, vi } from "vitest";
import { createRegistry, defineExtension, defineTask, Harness, MemoryStorage } from "../src/index.ts";
import { SCHEDULER_IDLE_STATE } from "../src/harness/harness.ts";
import type { Conversation, ConversationId } from "../src/index.ts";

async function fixture(backgroundTimers = false) {
	const clock = { now: 2_000, retention: 1_000 };
	const Read = defineTask<ConversationId, { phase: "read" }, null>({
		name: "context-reader",
		version: 1,
		initial: () => ({ phase: "read" }),
		phases: {
			read: async (task, runtime, ctx) => {
				await runtime.context(task.input, ctx);
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx);
			},
		},
		abort: async (_task, runtime, ctx) => {
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
		},
	});
	const registry = createRegistry();
	registry.install(defineExtension({ name: "reader", tasks: [Read] }));
	const harness = await Harness.open(
		new MemoryStorage(),
		{
			models: createModels(),
			registry,
			now: () => clock.now,
			settings: () => ({ contextRetentionMs: clock.retention }),
			setTimer: (callback, delay, { background }) => {
				if (background && !backgroundTimers) return undefined;
				const timer = setTimeout(callback, delay);
				return () => clearTimeout(timer);
			},
		},
		context,
	);
	harness.resume();
	const root = await harness.root(context);
	const conversation = async () => {
		const created = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
		await created.commit((tx) => tx.appendEntry(created.id, { kind: "note" }), context);
		return created;
	};
	const read = async (target: Conversation) => {
		const id = await root.commit(
			(tx) => tx.createTask(Read, target.id, { ownership: { kind: "conversation" } }),
			context,
		);
		await harness.waitForTask(id, context);
	};
	const state = (): unknown => Reflect.get(harness, SCHEDULER_IDLE_STATE);
	return { harness, clock, conversation, read, state };
}

test("expires retained contexts in clock order without full-scope checks for unrelated tasks", async () => {
	const { harness, clock, conversation, read, state } = await fixture();
	try {
		const late = await conversation();
		const early = await conversation();
		await read(late);
		clock.now = 1_000;
		await read(early);
		expect(state()).toEqual({ contexts: 2, idleContexts: 2, idleMismatches: 0, fullIdleChecks: 0 });
		clock.now = 2_500;
		await read(late);
		expect(state()).toEqual({ contexts: 1, idleContexts: 1, idleMismatches: 0, fullIdleChecks: 0 });
	} finally {
		await harness.close(context);
	}
});

test("zero retention removes earlier contexts even after the clock moves backward", async () => {
	const { harness, clock, conversation, read, state } = await fixture();
	try {
		const first = await conversation();
		const second = await conversation();
		await read(first);
		expect(state()).toMatchObject({ contexts: 1, idleContexts: 1 });
		clock.now = 1_000;
		clock.retention = 0;
		await read(second);
		expect(state()).toEqual({ contexts: 0, idleContexts: 0, idleMismatches: 0, fullIdleChecks: 0 });
	} finally {
		await harness.close(context);
	}
});

test("the background deadline expires idle context without another task or commit", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const { harness, clock, conversation, read, state } = await fixture(true);
	try {
		clock.retention = 20;
		const target = await conversation();
		await read(target);
		expect(state()).toMatchObject({ contexts: 1, idleContexts: 1, idleMismatches: 0 });
		clock.now += 20;
		await vi.advanceTimersByTimeAsync(20);
		expect(state()).toMatchObject({ contexts: 0, idleContexts: 0, idleMismatches: 0 });
		await read(target);
		expect(state()).toMatchObject({ contexts: 1, idleContexts: 1, idleMismatches: 0 });
	} finally {
		await harness.close(context);
		vi.useRealTimers();
	}
});
