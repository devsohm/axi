import { BACKGROUND_CONTEXT as context } from "@axi/objects/context";
import { expect, test } from "vitest";
import { createSession, defineDoc, defineDocFamily, MemoryStorage } from "../src/index.ts";

const State = defineDoc({
	kind: "history-boundary",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ count: 0 }),
	checkpointWhen: () => false,
});

test.each([undefined, null, "1", 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
	"historical snapshots reject invalid entry IDs: %s",
	async (entry) => {
		const session = createSession(new MemoryStorage());
		try {
			const conversation = await session.commit(
				(tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
				context,
			);
			await expect(
				Reflect.apply(session.snapshotAsOf, session, [State, conversation.id, entry, context]),
			).rejects.toThrow("requires an entry ID");
			await session.commit(async (tx) => {
				(await tx.doc(State, conversation.id)).count = 7;
			}, context);
			expect(await session.snapshot(State, conversation.id, context)).toEqual({ count: 7 });
		} finally {
			await session.close(context);
		}
	},
);

test("historical reads require conversation scope without failing later ordinary document access", async () => {
	const Counter = defineDoc({
		kind: "session-history",
		version: 1,
		scope: "session",
		initial: () => ({ count: 0 }),
		checkpointWhen: () => false,
	});
	const session = createSession(new MemoryStorage());
	try {
		await expect(Reflect.apply(session.snapshotAsOf, session, [Counter, 1, context])).rejects.toThrow(
			"requires a conversation document",
		);
		await session.commit((tx) => tx.doc(Counter), context);
		expect(await session.snapshot(Counter, context)).toEqual({ count: 0 });
	} finally {
		await session.close(context);
	}
});

test("entry visibility is checked before a historical document can be read", async () => {
	const session = createSession(new MemoryStorage());
	try {
		const [first, second] = await session.commit(
			async (tx) => [
				await tx.createConversation({ ownership: { kind: "ownerless" } }),
				await tx.createConversation({ ownership: { kind: "ownerless" } }),
			],
			context,
		);
		const entry = await session.commit((tx) => tx.appendEntry(first!.id, { kind: "marker" }), context);
		await expect(session.snapshotAsOf(State, second!.id, entry.id, context)).rejects.toThrow(
			"not visible from conversation",
		);
		expect(await session.snapshotAsOf(State, first!.id, entry.id, context)).toBeUndefined();
	} finally {
		await session.close(context);
	}
});

test("family history reads the selected key at its entry boundary and does not manufacture earlier state", async () => {
	const Notes = defineDocFamily({
		kind: "history-notes",
		family: true,
		version: 1,
		scope: "conversation",
		history: "rewindable",
		fork: "asOf",
		initial: (count: number) => ({ count }),
		checkpointWhen: () => false,
	});
	const session = createSession(new MemoryStorage());
	try {
		const conversation = await session.commit(
			(tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
			context,
		);
		const before = await session.commit((tx) => tx.appendEntry(conversation.id, { kind: "before" }), context);
		const first = await session.commit(async (tx) => {
			await tx.doc(Notes, conversation.id, "one", 1);
			await tx.doc(Notes, conversation.id, "two", 20);
			return tx.appendEntry(conversation.id, { kind: "created" });
		}, context);
		await session.commit(async (tx) => {
			(await tx.doc(Notes, conversation.id, "one", 1)).count = 2;
		}, context);
		expect(await session.snapshotAsOf(Notes, conversation.id, "one", before.id, context)).toBeUndefined();
		expect(await session.snapshotAsOf(Notes, conversation.id, "one", first.id, context)).toEqual({ count: 1 });
		expect(await session.snapshotAsOf(Notes, conversation.id, "two", first.id, context)).toEqual({ count: 20 });
		expect(await session.snapshot(Notes, conversation.id, "one", context)).toEqual({ count: 2 });
	} finally {
		await session.close(context);
	}
});

test("a missing historical document body is reported instead of returning the current value", async () => {
	class Storage extends MemoryStorage {
		missing = false;
		override async document(...args: Parameters<MemoryStorage["document"]>) {
			return this.missing && args[1] !== "current" ? undefined : super.document(...args);
		}
	}
	const storage = new Storage(),
		session = createSession(storage);
	try {
		const conversation = await session.commit(
			(tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
			context,
		);
		const entry = await session.commit(async (tx) => {
			(await tx.doc(State, conversation.id)).count = 1;
			return tx.appendEntry(conversation.id, { kind: "marker" });
		}, context);
		await session.commit(async (tx) => {
			(await tx.doc(State, conversation.id)).count = 2;
		}, context);
		storage.missing = true;
		await expect(session.snapshotAsOf(State, conversation.id, entry.id, context)).rejects.toThrow(
			/Historical document.*cannot be read/,
		);
		expect(await session.snapshot(State, conversation.id, context)).toEqual({ count: 2 });
	} finally {
		await session.close(context);
	}
});
