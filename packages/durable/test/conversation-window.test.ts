import { createModels, fauxProvider } from "@axi/ai";
import { BACKGROUND_CONTEXT as context } from "@axi/objects/context";
import { applyImmutable } from "@axi/objects/delta";
import type { WatchCall } from "@axi/objects/watch";
import { expect, test } from "vitest";
import {
	AgentDoc,
	ConversationTranscript,
	createRegistry,
	defineDoc,
	Harness,
	MemoryStorage,
	ResetEntry,
	type ConversationView,
	type EntryId,
} from "../src/index.ts";

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

test("keeps independent observer windows and replays document removal and replacement", async () => {
	const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry: createRegistry() }, context);
	try {
		const conversation = await harness.root(context);
		const append = (kind: string) => conversation.commit(tx => tx.appendEntry(conversation.id, { kind }), context);
		const written = [];
		for (const kind of ["opening", "context", "question", "answer"]) written.push(await append(kind));
		const windows = [{ from: written[2]!.id, min: 2, max: 3 }, { min: 1, max: 2 }];
		const subscriptions = await Promise.all(windows.map(async window => {
			const frames: WatchCall<ConversationView>[] = [];
			const observation = await harness.observeConversation(conversation.id, {
				advance(call) { frames.push(call); }, end() {},
			}, context, window);
			return { observation, frames };
		}));
		try {
			expect(subscriptions.map(({ observation }) => observation.value.entries.map(entry => entry.kind))).toEqual([
				["question", "answer"], ["answer"],
			]);
			expect(subscriptions[0]!.observation.value.before).toBe(written[1]!.id);
			expect(subscriptions[0]!.observation.value.docs).toBe(subscriptions[1]!.observation.value.docs);
			await append("follow-up");
			const burst = await conversation.commit(async tx => {
				const result = [];
				for (const kind of ["tool", "result", "closing"]) result.push(await tx.appendEntry(conversation.id, { kind }));
				return result;
			}, context);
			const windowFrame = subscriptions[0]!.frames[1];
			if (windowFrame?.kind !== "value") throw new Error("Missing window update");
			expect(windowFrame.value.entries.map(entry => entry.kind)).toEqual(["result", "closing"]);
			expect(windowFrame.value.before).toBe(burst[0]!.id);
			const shortFrame = subscriptions[1]!.frames[1];
			if (shortFrame?.kind !== "value") throw new Error("Missing short-window update");
			expect(shortFrame.value.entries.map(entry => entry.kind)).toEqual(["closing"]);
			expect(shortFrame.value.before).toBe(burst[1]!.id);
			await conversation.commit(tx => tx.retireDoc(AgentDoc, conversation.id), context);
			await conversation.commit(async tx => { (await tx.doc(AgentDoc, conversation.id)).instructions = "Replacement"; }, context);
			const privateState = defineDoc({ kind: "private-view-state", version: 1, scope: "conversation",
				history: "latest", fork: "initial", initial: () => ({ value: 0 }), checkpointWhen: () => false });
			await conversation.commit(async tx => { (await tx.doc(privateState, conversation.id)).value++; }, context);
			for (const { observation, frames } of subscriptions) {
				expect(frames).toHaveLength(4);
				let replayed = observation.value;
				for (const frame of frames) {
					if (frame.kind !== "value") throw frame.error;
					replayed = applyImmutable(replayed, frame.ops);
					expect(replayed).toEqual(frame.value);
					expect(frame.retired).toBe(false);
				}
				const retired = frames[2];
				if (retired?.kind !== "value") throw new Error("Missing retirement");
				expect(retired.value.docs).not.toHaveProperty(AgentDoc.definition.kind);
				expect(replayed.docs[AgentDoc.definition.kind]).toEqual({ instructions: "Replacement" });
				expect(replayed.docs).not.toHaveProperty(privateState.definition.kind);
			}
			expect(subscriptions[0]!.observation.value.entries.map(entry => entry.kind)).toEqual(["question", "answer"]);
		} finally {
			for (const { observation } of subscriptions) observation.detach();
		}
	} finally { await harness.close(context); }
});

test("rejects invalid window bounds and still accepts a one-entry window", async () => {
	const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry: createRegistry() }, context);
	try {
		const conversation = await harness.root(context);
		for (const window of [{ min: 0 }, { min: 0.5 }, { min: NaN }, { min: 2, max: 1 }, { max: Infinity }]) {
			await expect(conversation.watch(context, window)).rejects.toBeInstanceOf(RangeError);
			await expect(harness.observeConversation(conversation.id, { advance() {}, end() {} }, context, window)).rejects.toBeInstanceOf(RangeError);
		}
		const watch = await conversation.watch(context, { min: 1, max: 1 });
		try { expect(watch.value.entries).toEqual([]); } finally { await watch.stop(); }
	} finally { await harness.close(context); }
});

test.each([undefined, "Continue with the approved plan"])(
	"reset changes model context without deleting inspectable history: %s",
	async (handoff) => {
		const models = createModels();
		models.setProvider(fauxProvider().provider);
		const harness = await Harness.open(
			new MemoryStorage(),
			{ models: () => models, registry: createRegistry() },
			context,
		);
		try {
			const conversation = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
			await conversation.commit(
				(tx) =>
					tx.appendEntry(conversation.id, {
						kind: "note",
						head: "self",
						model: [{ role: "user", content: "Earlier conversation", timestamp: 1 }],
					}),
				context,
			);
			expect((await conversation.context(context)).messages).toContainEqual(
				expect.objectContaining({ content: "Earlier conversation" }),
			);
			await conversation.reset(handoff, context);
			const view = await conversation.context(context);
			expect(view.messages).toEqual(
				handoff === undefined ? [] : [expect.objectContaining({ role: "user", content: handoff })],
			);
			const entries = (await conversation.entries({ order: "ascending" }, 10, undefined, context)).items;
			expect(entries).toHaveLength(2);
			expect(entries[0]!.model).toEqual([{ role: "user", content: "Earlier conversation", timestamp: 1 }]);
			expect(ResetEntry.is(entries[1])).toBe(true);
		} finally {
			await harness.close(context);
		}
	},
);
