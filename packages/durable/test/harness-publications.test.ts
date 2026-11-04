import { createModels } from "@axi/ai";
import type { WatchCall, WatchEnd } from "@axi/objects";
import { BACKGROUND_CONTEXT as context } from "@axi/objects/context";
import { expect, test } from "vitest";
import {
	AgentDoc,
	createRegistry,
	defineTask,
	Harness,
	MemoryStorage,
	type ConversationView,
	type TaskGraph,
} from "../src/index.ts";

test("shares graph publications, document operations and close notifications among recipients", async () => {
	const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry: createRegistry() }, context);
	const graphFrames: WatchCall<TaskGraph>[] = [], graphEnds: WatchEnd[] = [];
	const viewFrames: WatchCall<ConversationView>[] = [], viewEnds: WatchEnd[] = [];
	try {
		const conversation = await harness.root(context);
		for (let index = 0; index < 2; index++) {
			await harness.observeTaskGraph({ advance: call => { graphFrames.push(call); }, end: end => { graphEnds.push(end); } }, context);
			await harness.observeConversation(conversation.id, { advance: call => { viewFrames.push(call); }, end: end => { viewEnds.push(end); } }, context);
		}
		const watches = [await harness.watchTaskGraph(context), await conversation.watch(context)];
		const task = defineTask<null, { phase: "wait" }, null>({
			name: "held", version: 1, initial: () => ({ phase: "wait" }),
			phases: { wait: async () => {} }, abort: async () => {},
		});
		await conversation.commit(tx => tx.createTask(task, null, { ownership: { kind: "conversation" } }), context);
		await conversation.commit(async tx => { (await tx.doc(AgentDoc, conversation.id)).instructions = "Review"; }, context);
		await harness.close(context);
		const ends = await Promise.all(watches.map(watch => watch.closed));
		expect(graphFrames).toHaveLength(2);
		expect(viewFrames).toHaveLength(2);
		expect(graphFrames[0]).toBe(graphFrames[1]);
		if (viewFrames[0]?.kind !== "value" || viewFrames[1]?.kind !== "value") throw new Error("Missing document revisions");
		expect(viewFrames[0].ops).toBe(viewFrames[1].ops);
		expect(graphEnds[0]).toBe(graphEnds[1]);
		expect(viewEnds[0]).toBe(viewEnds[1]);
		expect(ends[0]).toBe(ends[1]);
	} finally {
		await harness.close(context);
	}
});
