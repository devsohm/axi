import { createModels } from "@axi/ai";
import { BACKGROUND_CONTEXT as context, withAbortSignal } from "@axi/objects/context";
import type { WatchCall, WatchEnd } from "@axi/objects/watch";
import { expect, test, vi } from "vitest";
import {
	createRegistry,
	defineExtension,
	defineTask,
	Harness,
	MemoryStorage,
	ROOT_CONVERSATION_ID,
	type TaskGraph,
	type TaskId,
	type TaskRecord,
	type TaskState,
} from "../src/index.ts";
import { idFromNumber } from "../src/ids.ts";
import { commitWrites } from "../src/testing/commit-writes.ts";
import { SessionImpl } from "../src/session/session.ts";

const definition = defineTask<null, { phase: "run" }, null>({
	name: "graph-job",
	version: 1,
	initial: () => ({ phase: "run" }),
	phases: {
		async run() {
			throw new Error("Graph inspection must not schedule this task");
		},
	},
	async abort() {},
});
const extension = defineExtension({ name: "graph-jobs", tasks: [definition] });

async function fixture() {
	const registry = createRegistry(),
		storage = new MemoryStorage(),
		reports: unknown[] = [];
	const harness = await Harness.open(
		storage,
		{ models: createModels(), registry, onReport: ({ error }) => reports.push(error) },
		context,
	);
	if (!(harness instanceof SessionImpl)) throw new Error("Harness must expose its session implementation");
	const root = await harness.root(context);
	const create = () =>
		root.commit((tx) => tx.createTask(definition, null, { ownership: { kind: "conversation" } }), context);
	return { harness, storage, registry, reports, root, create };
}

test("recovered graphs retain waiting, sleeping and completing work while returning interrupted work to pending", async () => {
	const storage = new MemoryStorage();
	const states: TaskState<{ phase: "run" }, null>[] = [
		{ status: "pending", checkpoint: { phase: "run" } },
		{ status: "running", checkpoint: { phase: "run" } },
		{ status: "waiting", checkpoint: { phase: "run" }, policy: "allSettled", on: [] },
		{ status: "sleeping", checkpoint: { phase: "run" }, until: Date.now() + 60000 },
		{ status: "completing", outcome: { status: "completed", result: null } },
		{ status: "terminal", outcome: { status: "completed", result: null } },
		{ status: "pending", checkpoint: { phase: "run" } },
	];
	const records = states.map((state, index): TaskRecord<null, { phase: "run" }, null> => {
		const base = {
			id: idFromNumber<TaskId<null>>(index + 2),
			kind: definition.definition.name,
			version: 1,
			input: null,
			conversationId: ROOT_CONVERSATION_ID,
			background: index === 3,
			abortRequested: false,
			...(index === 6 ? { owner: idFromNumber<TaskId>(6) } : {}),
		};
		return state.status === "completing" || state.status === "terminal" ? { ...base, state } : { ...base, state };
	});
	await commitWrites(
		storage,
		[
			{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } },
			...records.map((value) => ({ type: "task" as const, value })),
		],
		context,
	);
	const harness = await Harness.open(storage, { registry: createRegistry(), models: createModels() }, context);
	try {
		const graph = await harness.watchTaskGraph(context);
		try {
			expect(Object.keys(graph.value.tasks)).toEqual(["2", "3", "4", "5", "6", "8"]);
			expect(Object.values(graph.value.tasks).map((task) => task.state.status)).toEqual([
				"pending",
				"pending",
				"waiting",
				"sleeping",
				"completing",
				"pending",
			]);
			expect(graph.value.tasks["4"]?.state).toEqual({ status: "waiting", phase: "run", policy: "allSettled", on: [] });
			expect(graph.value.tasks["6"]?.state).toEqual({ status: "completing", outcome: "completed" });
			expect(graph.value.tasks["5"]?.background).toBe(true);
		} finally {
			await graph.stop();
		}
	} finally {
		await harness.close(context);
	}
});

test("graphs update blocked reasons when a task definition is installed and removed", async () => {
	const { harness, create, registry } = await fixture();
	try {
		const id = await create(),
			graph = await harness.watchTaskGraph(context);
		graph.start(async () => {});
		try {
			expect(graph.value.tasks[String(id)]?.blocked).toBe("missing_task");
			registry.install(extension);
			await vi.waitFor(() => expect(graph.value.tasks[String(id)]?.blocked).toBeUndefined());
			registry.uninstall(extension);
			await vi.waitFor(() => expect(graph.value.tasks[String(id)]?.blocked).toBe("missing_task"));
			expect((await harness.inspect(context)).scheduling).toBe("paused");
		} finally {
			await graph.stop();
		}
	} finally {
		await harness.close(context);
	}
});

test("live graph updates retain ownership, omit unchanged tasks and remove terminal tasks", async () => {
	const { harness, root, create } = await fixture();
	const frames: WatchCall<TaskGraph>[] = [];
	try {
		const graph = await harness.watchTaskGraph(context);
		graph.start(async () => {});
		const observation = await harness.observeTaskGraph(
			{
				advance: (frame) => {
					frames.push(frame);
				},
				end() {},
			},
			context,
		);
		try {
			const id = await create();
			await harness.commit(async (tx) => {
				await tx.createConversation({ ownership: { kind: "task", taskId: id } });
				await tx.createConversation({ ownership: { kind: "task", taskId: id } });
				await tx.createTask(definition, null, { conversationId: root.id, ownership: { kind: "task", taskId: id } });
			}, context);
			const node = graph.value.tasks[String(id)];
			expect(node?.conversations).toHaveLength(2);
			expect(node?.conversations).toEqual([...node!.conversations].sort((a, b) => a - b));
			expect(Object.values(graph.value.tasks).filter((task) => task.owner === id)).toHaveLength(1);
			const previous = frames.length;
			await harness.commitWith(async (tx) => {
				const task = await tx.task(id);
				if (!task) throw new Error("Missing task");
				tx.setTask(task);
			}, context);
			expect(frames).toHaveLength(previous);
			await harness.commitWith(async (tx) => {
				const task = await tx.task(id);
				if (!task) throw new Error("Missing task");
				tx.setTask({ ...task, state: { status: "running", checkpoint: { phase: "run" } } });
			}, context);
			await vi.waitFor(() => expect(graph.value.tasks[String(id)]?.state).toEqual({ status: "running", phase: "run" }));
			await harness.commitWith(async (tx) => {
				const task = await tx.task(id);
				if (!task) throw new Error("Missing task");
				const { memos: _memos, ...record } = task;
				tx.setTask({ ...record, state: { status: "terminal", outcome: { status: "completed", result: null } } });
			}, context);
			await vi.waitFor(() => expect(graph.value.tasks[String(id)]).toBeUndefined());
			expect(frames).toHaveLength(previous + 2);
		} finally {
			observation.detach();
			await graph.stop();
		}
	} finally {
		await harness.close(context);
	}
});

test.each(["throws", "rejects"])(
	"a graph observer that %s is detached while other observers keep receiving state",
	async (mode) => {
		const { harness, create, reports } = await fixture();
		const ends: WatchEnd[] = [],
			failure = new Error("Graph listener failed");
		try {
			const observer = await harness.observeTaskGraph(
				{
					advance() {
						if (mode === "throws") throw failure;
						return Promise.reject(failure);
					},
					end: (end) => {
						ends.push(end);
					},
				},
				context,
			);
			const graph = await harness.watchTaskGraph(context);
			graph.start(async () => {});
			try {
				await create();
				await vi.waitFor(() => expect(ends).toHaveLength(1));
				expect(ends[0]).toEqual({ kind: "listener_error", error: failure });
				await create();
				await vi.waitFor(() => expect(Object.keys(graph.value.tasks)).toHaveLength(2));
				expect(ends).toHaveLength(1);
				expect(reports).toEqual([failure]);
			} finally {
				observer.detach();
				await graph.stop();
			}
		} finally {
			await harness.close(context);
		}
	},
);

test("detached observations freeze their initial snapshot and new watches see later commits", async () => {
	const { harness, create } = await fixture();
	const calls: WatchCall<TaskGraph>[] = [];
	try {
		const observation = await harness.observeTaskGraph(
			{
				advance: (frame) => {
					calls.push(frame);
				},
				end() {},
			},
			context,
		);
		observation.detach();
		observation.detach();
		await create();
		expect(observation.value).toEqual({ tasks: {} });
		expect(calls).toEqual([]);
		const graph = await harness.watchTaskGraph(context);
		expect(Object.keys(graph.value.tasks)).toHaveLength(1);
		await graph.stop();
	} finally {
		await harness.close(context);
	}
});

test("graph attachments honor cancellation and distinguish observation close from watch end", async () => {
	const { harness } = await fixture();
	const reason = new Error("Caller cancelled"),
		ends: WatchEnd[] = [];
	try {
		await expect(harness.watchTaskGraph(withAbortSignal(AbortSignal.abort(reason), context))).rejects.toBe(reason);
		await expect(
			harness.observeTaskGraph({ advance() {}, end() {} }, withAbortSignal(AbortSignal.abort(reason), context)),
		).rejects.toBe(reason);
		await harness.observeTaskGraph(
			{
				advance() {},
				end: (end) => {
					ends.push(end);
				},
			},
			context,
		);
		const watch = await harness.watchTaskGraph(context);
		await harness.close(context);
		expect(await watch.closed).toEqual({ kind: "ended" });
		expect(ends).toMatchObject([{ kind: "failed", error: { message: "session closed" } }]);
		await expect(harness.watchTaskGraph(context)).rejects.toThrow(/closed/);
	} finally {
		await harness.close(context);
	}
});
