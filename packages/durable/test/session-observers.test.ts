import type { Context } from "@axi/objects/context";
import type { WatchEnd } from "@axi/objects/watch";
import { BACKGROUND_CONTEXT as context } from "@axi/objects/context";
import { describe, expect, it } from "vitest";
import { createSession, defineDoc, MemoryStorage, type StorageWrite } from "../src/index.ts";

const Counter = defineDoc({
	kind: "observed-counter",
	version: 1,
	scope: "session",
	initial: () => ({ count: 0 }),
	checkpointWhen: () => false,
});
const Note = defineDoc({
	kind: "held-note",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ text: "" }),
	checkpointWhen: () => false,
});

class RecordingStorage extends MemoryStorage {
	adopting = false;
	writes = 0;
	override commit(
		batch: readonly (readonly StorageWrite[])[],
		adopt: Parameters<MemoryStorage["commit"]>[1],
		ctx: Context,
	) {
		this.writes++;
		return super.commit(
			batch,
			(index, seq) => {
				this.adopting = true;
				try {
					adopt(index, seq);
				} finally {
					this.adopting = false;
				}
			},
			ctx,
		);
	}
}

describe("session observers", () => {
	it("publishes committed values after storage receipts and before host notification and contains a faulty observer", async () => {
		const storage = new RecordingStorage();
		const session = createSession(storage);
		await session.commit((tx) => tx.doc(Counter), context);
		const order: string[] = [];
		const ends: WatchEnd[] = [];
		await session.observeDoc(
			Counter,
			{
				advance: () => {
					throw new Error("faulty observer");
				},
				end: (end) => ends.push(end),
			},
			context,
		);
		const observed = (await session.observeDoc(
			Counter,
			{
				advance: (call) => {
					if (call.kind === "value") order.push(`doc:${call.value.count}:${storage.adopting}`);
				},
				end: () => {},
			},
			context,
		))!;
		const commits = session.observeCommits({ advance: () => order.push(`commit:${storage.adopting}`), end: () => {} });
		await session.commit(async (tx) => {
			(await tx.doc(Counter)).count = 1;
		}, context);
		await session.commit(async (tx) => {
			(await tx.doc(Counter)).count = 2;
		}, context);
		expect(observed.value).toEqual({ count: 0 });
		expect(order).toEqual(["doc:1:false", "commit:false", "doc:2:false", "commit:false"]);
		expect(ends).toEqual([{ kind: "listener_error", error: new Error("faulty observer") }]);
		commits.detach();
		observed.detach();
		await session.close(context);
		expect(ends).toHaveLength(1);
	});

	it("holds progress in memory and publishes the complete stored change exactly once on close", async () => {
		const storage = new RecordingStorage();
		const session = createSession(storage);
		const conversation = await session.commit(
			(tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
			context,
		);
		await session.commit((tx) => tx.doc(Note, conversation.id), context);
		const writes = storage.writes;
		const seen: string[] = [];
		await session.observeDoc(
			Note,
			conversation.id,
			{
				advance: (call) => {
					if (call.kind === "value") seen.push(call.value.text);
				},
				end: () => {},
			},
			context,
		);
		const stored: unknown[] = [];
		session.observeCommits({ advance: (publication) => stored.push(publication.changes), end: () => {} });
		for (const text of ["a", "b"])
			await session.commit(
				async (tx) => {
					(await tx.doc(Note, conversation.id)).text += text;
				},
				context,
				{ persistence: { kind: "deferred", withinMs: Infinity } },
			);
		expect(storage.writes).toBe(writes);
		expect(stored).toEqual([]);
		expect(seen).toEqual(["a", "ab"]);
		await session.close(context);
		expect(storage.writes).toBe(writes + 1);
		expect(stored).toMatchObject([[{ kind: "change", value: { text: "ab" }, ops: [["a", ["text"], "ab"]] }]]);
	});

	it.each(["document", "commit"] as const)(
		"isolates an asynchronously failing %s observer, including a rejected end callback",
		async (target) => {
			const session = createSession(new MemoryStorage());
			let calls = 0;
			const ends: WatchEnd[] = [], values: number[] = [];
			const faulty = {
				async advance() {
					calls++;
					throw "Observer rejected";
				},
				async end(end: WatchEnd) {
					ends.push(end);
					throw new Error("End callback rejected");
				},
			};
			try {
				await session.commit((tx) => tx.doc(Counter), context);
				if (target === "document") await session.observeDoc(Counter, faulty, context);
				else session.observeCommits(faulty);
				await session.observeDoc(Counter, {
					advance: (call) => { if (call.kind === "value") values.push(call.value.count); },
					end() {},
				}, context);
				for (const count of [1, 2]) await session.commit(async (tx) => {
					(await tx.doc(Counter)).count = count;
				}, context);
				expect(values).toEqual([1, 2]);
				expect(calls).toBe(1);
				expect(ends).toEqual([{ kind: "listener_error", error: new Error("Observer rejected") }]);
				await session.close(context);
				expect(await session.closed).toEqual({ kind: "closed" });
				expect(ends).toHaveLength(1);
			} finally { await session.close(context); }
		},
	);
});
