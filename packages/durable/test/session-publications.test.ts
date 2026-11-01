import type { Op } from "@axi/objects/delta";
import type { WatchEnd } from "@axi/objects";
import { BACKGROUND_CONTEXT as context } from "@axi/objects/context";
import { expect, test } from "vitest";
import { defineDoc, defineDocFamily, MemoryStorage } from "../src/index.ts";
import { type ObservedCommit, SessionImpl } from "../src/session/session.ts";

test("one publication and its terminal metadata are shared by the observers receiving them", async () => {
	const session = new SessionImpl(new MemoryStorage());
	const progress = defineDoc({
		kind: "progress", scope: "conversation", history: "latest", fork: "initial", version: 1,
		initial: () => ({ value: 0 }), checkpointWhen: () => false,
	});
	const counters = defineDocFamily({
		kind: "counters", scope: "session", family: true, version: 1,
		initial: (value: number) => ({ value }), checkpointWhen: () => false,
	});
	const memory: ObservedCommit[] = [];
	const retirements: (readonly Op[])[] = [];
	const ends: WatchEnd[] = [];
	for (let index = 0; index < 2; index++) {
		session.followCommits(publication => { if (publication.kind === "memory") memory.push(publication); });
		session.observeCommits({ advance: () => {}, end: end => { ends.push(end); } });
	}
	try {
		const conversation = await session.commit(async tx => {
			const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
			await tx.doc(progress, conversation.id);
			await tx.doc(counters, "first", 1);
			await tx.doc(counters, "second", 2);
			return conversation;
		}, context);
		const first = await session.watchDoc(progress, conversation.id, context);
		const second = await session.watchDoc(progress, conversation.id, context);
		if (!first || !second) throw new Error("The progress watches are missing");
		for (const key of ["first", "second"]) await session.observeDoc(counters, key, {
			advance: call => { if (call.kind === "value" && call.retired) retirements.push(call.ops); }, end: () => {},
		}, context);
		await session.commit(async tx => { (await tx.doc(progress, conversation.id)).value++; }, context, {
			persistence: { kind: "deferred", withinMs: Infinity },
		});
		await session.commit(async tx => {
			await tx.retireDoc(counters, "first");
			await tx.retireDoc(counters, "second");
		}, context);
		await session.close(context);
		const closed = await Promise.all([first.closed, second.closed]);
		expect({
			memoryCalls: memory.length, retirements: retirements.length, ends: ends.length,
			sharedPublication: memory[0] === memory[1], sharedRetirementOps: retirements[0] === retirements[1],
			sharedCommitEnd: ends[0] === ends[1], sharedWatchEnd: closed[0] === closed[1],
		}).toEqual({
			memoryCalls: 2, retirements: 2, ends: 2,
			sharedPublication: true, sharedRetirementOps: true, sharedCommitEnd: true, sharedWatchEnd: true,
		});
	} finally { await session.close(context); }
});
