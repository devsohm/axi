import { createModels } from "@axi/ai";
import type { Context } from "@axi/chord";
import { BACKGROUND_CONTEXT as context } from "@axi/chord/context";
import { expect, it } from "vitest";
import { idFromNumber } from "../src/ids.ts";
import {
	createRegistry,
	defineTask,
	Harness,
	MemoryStorage,
	ROOT_CONVERSATION_ID,
	type ReportInfo,
	type TaskId,
} from "../src/index.ts";

it("uses one restart limit for all tasks recovered during opening", async () => {
	const task = defineTask<null, { phase: "hold" }, null>({
		name: "recovering",
		version: 1,
		initial: () => ({ phase: "hold" }),
		phases: { hold: async () => {} },
		abort: async () => {},
	});
	const storage = new MemoryStorage();
	await storage.commit(
		[
			{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } },
			...[2, 3].map((id) => ({
				type: "task" as const,
				value: {
					id: idFromNumber<TaskId<null>>(id),
					conversationId: ROOT_CONVERSATION_ID,
					kind: "recovering",
					version: 1,
					input: null,
					background: false,
					abortRequested: false,
					state: { status: "running" as const, checkpoint: { phase: "hold" } },
				},
			})),
		],
		() => {},
		context,
	);
	const registry = createRegistry();
	registry.install({ name: "recovery", tasks: [task] });
	const reports: ReportInfo[] = [];
	let reads = 0;
	const harness = await Harness.open(
		storage,
		{
			models: createModels(),
			registry,
			settings: {
				get restartLimit() {
					return ++reads === 1 ? 1 : Infinity;
				},
			},
			onReport: (_error, info) => reports.push(info),
		},
		context,
	);
	try {
		expect(reports.flatMap((info) => (info.type === "task_parked" ? [info.task.id] : []))).toEqual([2, 3]);
	} finally {
		await harness.close(context);
	}
});

it("recovers a fail-fast wait without reading members after a known failure", async () => {
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
	await storage.commit(
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
		() => {},
		context,
	);
	const harness = await Harness.open(storage, { models: createModels(), registry: createRegistry() }, context);
	try {
		expect((await harness.inspect(context)).tasks.map(({ record }) => record.id)).toEqual([4]);
	} finally {
		await harness.close(context);
	}
});
