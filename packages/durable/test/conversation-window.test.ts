import { createModels } from "@axi/ai";
import { BACKGROUND_CONTEXT as context } from "@axi/objects/context";
import { expect, test } from "vitest";
import { ConversationTranscript, createRegistry, Harness, MemoryStorage, type ConversationView, type EntryId } from "../src/index.ts";

test("keeps the remaining sparse-ID gap until its bounded page is loaded", async () => {
	const conversation: ConversationView["conversation"] = { id: 1 as ConversationView["conversation"]["id"] };
	const docs = {};
	let reads = 0;
	const transcript = new ConversationTranscript(async query => {
		reads++;
		expect(query).toEqual({ minEntryId: 10, maxEntryId: 11, order: "ascending" });
		return { items: [] };
	});
	const merge = (ids: number[], before?: number) => transcript.merge({
		conversation, docs,
		entries: ids.map(id => ({ id: id as EntryId, conversationId: conversation.id, kind: "note" })),
		...(before === undefined ? {} : { before: before as EntryId }),
	});
	merge([3]);
	merge([12], 9);
	const view = merge([6, 9], 3);
	const gap = view.items.find(item => item.kind === "gap");
	if (!gap || gap.kind !== "gap") throw new Error("The unqueried interval is missing");
	await expect(transcript.fillGap(gap, context)).resolves.toMatchObject({
		items: [3, 6, 9, 12].map(id => ({ kind: "entry", entry: { id } })),
	});
	expect(reads).toBe(1);
});

test("keeps a bounded live window while the client loads missed and earlier transcript pages", async () => {
	const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry: createRegistry() }, context);
	try {
		const conversation = await harness.root(context);
		const append = (kind: string) => conversation.commit((tx) => tx.appendEntry(conversation.id, { kind }), context);
		for (const kind of ["a", "b", "c", "d"]) await append(kind);
		const transcript = new ConversationTranscript((query, limit, ctx) => conversation.entries(query, limit, undefined, ctx), { pageSize: 2 });
		const first = await conversation.watch(context, { min: 2, max: 3 });
		expect(first.value.entries.map((entry) => entry.kind)).toEqual(["c", "d"]);
		transcript.merge(first.value);
		await first.stop();
		for (const kind of ["e", "f", "g", "h"]) await append(kind);
		const resumed = await conversation.watch(context, { min: 2, max: 3, ...transcript.resume });
		let view = transcript.merge(resumed.value);
		expect(view.items.map((item) => item.kind)).toEqual(["earlier", "entry", "entry", "gap", "entry", "entry"]);
		const gap = view.items.find((item) => item.kind === "gap")!;
		view = await transcript.fillGap(gap, context);
		expect(view.items.some((item) => item.kind === "gap")).toBe(false);
		view = await transcript.loadEarlier(context);
		expect(view.items.flatMap((item) => item.kind === "entry" ? [item.entry.kind] : [])).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);
		expect(view.items[0]?.kind).toBe("entry");
		expect(transcript.merge(resumed.value).items).toBe(view.items);
		await resumed.stop();
	} finally {
		await harness.close(context);
	}
});
