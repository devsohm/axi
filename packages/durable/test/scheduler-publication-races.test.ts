import { BACKGROUND_CONTEXT as context, awaitWithContext } from "@axi/objects/context";
import { afterEach, expect, test, vi } from "vitest";
import { defineTask, MemoryStorage, type StorageWrite, type TaskId } from "../src/index.ts";
import { closeSchedulers, open, root } from "./scheduler-support.ts";

afterEach(closeSchedulers);
class PublicationStorage extends MemoryStorage {
	last: readonly StorageWrite[] = [];
	hold: (writes: readonly StorageWrite[]) => boolean = () => false;
	held: (() => void) | undefined;
	override async commit(...args: Parameters<MemoryStorage["commit"]>) {
		this.last = args[0].flat();
		return super.commit(...args);
	}
	publishing(publish: () => void): void {
		if (!this.held && this.hold(this.last)) this.held = publish;
		else publish();
	}
}

test.each(["holder", "waiter"] as const)(
	"a %s notification published while planning is retained for the next scheduler pass",
	async (mode) => {
		const release = Promise.withResolvers<void>();
		const child = defineTask<null, { phase: "hold" }, null>({
			name: "publication-child",
			version: 1,
			initial: () => ({ phase: "hold" }),
			phases: {
				hold: async (_task, runtime, ctx) => {
					await awaitWithContext(release.promise, ctx);
					await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx);
				},
			},
			abort: async () => {},
		});
		const children = new Map<TaskId, TaskId>();
		const parent = defineTask<null, { phase: "spawn" }, null>({
			name: "publication-parent",
			version: 1,
			initial: () => ({ phase: "spawn" }),
			phases: {
				spawn: async (task, runtime, ctx) => {
					await runtime.commit(async (tx) => {
						children.set(task.id, await tx.createTask(child, null, { ownership: { kind: "task", taskId: task.id } }));
					}, ctx);
					await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx);
				},
			},
			abort: async () => {},
		});
		const waiter = defineTask<TaskId[], { phase: "wait" | "finish" }, null>({
			name: "publication-waiter",
			version: 1,
			initial: () => ({ phase: "wait" }),
			phases: {
				wait: (task, runtime, ctx) =>
					runtime.commit(
						() => ({ status: "waiting", checkpoint: { phase: "finish" }, on: task.input, policy: "allSettled" }),
						ctx,
					),
				finish: (_task, runtime, ctx) =>
					runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx),
			},
			abort: async () => {},
		});
		const storage = new PublicationStorage(),
			{ session, scheduler } = await open([parent, child, waiter], { storage });
		const conversationId = await root(session);
		const start = () =>
			session.commit(
				(tx) => tx.createTask(parent, null, { conversationId, ownership: { kind: "conversation" } }),
				context,
			);
		const first = await start(),
			second = mode === "holder" ? await start() : undefined;
		scheduler.resume();
		await vi.waitFor(async () => {
			for (const id of [first, second].filter((id) => id !== undefined))
				expect((await storage.task(id, context))?.state.status).toBe("completing");
		});
		let target = first;
		if (mode === "waiter") {
			const childId = children.get(first);
			if (childId === undefined) throw new Error("Missing child");
			target = await session.commit(
				(tx) => tx.createTask(waiter, [first, childId], { conversationId, ownership: { kind: "conversation" } }),
				context,
			);
			await vi.waitFor(async () => expect((await storage.task(target, context))?.state.status).toBe("waiting"));
		}
		await new Promise<void>((resolve) => setImmediate(resolve));
		const heldTask = mode === "holder" ? children.get(second!) : first;
		let released = false;
		storage.hold = (writes) =>
			!released &&
			writes.some(
				(write) => write.type === "task" && write.value.id === heldTask && write.value.state.status === "terminal",
			);
		const touch = session.touch.bind(session);
		session.touch = (key) => {
			if (storage.held && key === `task:${mode === "holder" ? first : target}`) {
				const publication = storage.held;
				storage.held = undefined;
				released = true;
				queueMicrotask(publication);
			}
			return touch(key);
		};
		try {
			release.resolve();
			await vi.waitFor(() => expect(released).toBe(true));
			await vi.waitFor(async () =>
				expect((await storage.task(mode === "holder" ? second! : target, context))?.state.status).toBe("terminal"),
			);
			expect((await storage.task(first, context))?.state.status).toBe("terminal");
		} finally {
			storage.hold = () => false;
			storage.held?.();
			release.resolve();
		}
	},
);
