import { BACKGROUND_CONTEXT as context } from "@axi/objects/context";
import { describe, expect, test } from "vitest";
import { createSession, defineDoc, defineDocFamily, MemoryStorage } from "../src/index.ts";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";

const State = defineDoc({
	kind: "fork-transaction-state",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ count: 0 }),
	checkpointWhen: () => false,
});
const Current = defineDoc({
	kind: "fork-transaction-current",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ count: 0 }),
	checkpointWhen: () => false,
});
const Notes = defineDocFamily({
	kind: "fork-transaction-notes",
	family: true,
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: (text: string) => ({ text }),
	checkpointWhen: () => false,
});

async function populate(session: ReturnType<typeof createSession>) {
	const parent = await session.commit((tx) => tx.createConversation({ ownership: { kind: "ownerless" } }), context);
	const point = await session.commit(async (tx) => {
		(await tx.doc(State, parent.id)).count = 4;
		(await tx.doc(Current, parent.id)).count = 4;
		await tx.doc(Notes, parent.id, "first", "saved");
		return tx.appendEntry(parent.id, { kind: "fork-point" });
	}, context);
	await session.commit(async (tx) => {
		(await tx.doc(State, parent.id)).count = 9;
		(await tx.doc(Current, parent.id)).count = 9;
		(await tx.doc(Notes, parent.id, "first", "unused")).text = "later";
	}, context);
	return { parent, point };
}

describe.each([
	{ name: "memory", open: async () => new MemoryStorage() },
	{ name: "SQLite", open: () => openNodeSqliteStorage(":memory:") },
])("$name fork transactions", ({ open }) => {
	test("copied drafts use their selected history and share edits inside the transaction", async () => {
		const session = createSession(await open());
		try {
			const { parent, point } = await populate(session);
			const child = await session.commit(async (tx) => {
				const child = await tx.forkConversation(parent.id, point.id, { ownership: { kind: "ownerless" } });
				const first = tx.doc(State, child.id);
				const repeated = tx.doc(State, child.id);
				expect(await repeated).toBe(await first);
				expect(await first).toEqual({ count: 4 });
				(await first).count = 7;
				const current = await tx.doc(Current, child.id);
				expect(current.count).toBe(9);
				current.count++;
				const note = await tx.doc(Notes, child.id, "first", "unused");
				expect(note.text).toBe("saved");
				note.text += " child";
				return child;
			}, context);
			expect(await session.snapshot(State, child.id, context)).toEqual({ count: 7 });
			expect(await session.snapshot(Current, child.id, context)).toEqual({ count: 10 });
			expect(await session.snapshot(Notes, child.id, "first", context)).toEqual({ text: "saved child" });
			expect(await session.snapshot(State, parent.id, context)).toEqual({ count: 9 });
			expect(await session.snapshot(Notes, parent.id, "first", context)).toEqual({ text: "later" });
		} finally {
			await session.close(context);
		}
	});

	test.each([false, true])("retiring a copied document is idempotent after acquisition=%s", async (acquire) => {
		const session = createSession(await open());
		try {
			const { parent, point } = await populate(session);
			const child = await session.commit(async (tx) => {
				const child = await tx.forkConversation(parent.id, point.id, { ownership: { kind: "ownerless" } });
				if (acquire) (await tx.doc(State, child.id)).count = 12;
				await tx.retireDoc(State, child.id);
				await tx.retireDoc(State, child.id);
				return child;
			}, context);
			expect(await session.snapshot(State, child.id, context)).toBeUndefined();
			expect(await session.snapshot(Current, child.id, context)).toEqual({ count: 9 });
			expect(await session.snapshot(State, parent.id, context)).toEqual({ count: 9 });
			await session.commit(async (tx) => {
				const fresh = await tx.doc(State, child.id);
				expect(fresh.count).toBe(0);
				fresh.count = 3;
			}, context);
			expect(await session.snapshot(State, child.id, context)).toEqual({ count: 3 });
		} finally {
			await session.close(context);
		}
	});

	test("retiring and recreating a fork copy in one commit uses the initial value", async () => {
		const session = createSession(await open());
		try {
			const { parent, point } = await populate(session);
			const child = await session.commit(async (tx) => {
				const child = await tx.forkConversation(parent.id, point.id, { ownership: { kind: "ownerless" } });
				await tx.retireDoc(Notes, child.id, "first");
				const fresh = await tx.doc(Notes, child.id, "first", "replacement");
				expect(fresh.text).toBe("replacement");
				fresh.text += " edited";
				return child;
			}, context);
			expect(await session.snapshot(Notes, child.id, "first", context)).toEqual({ text: "replacement edited" });
			expect(await session.snapshot(Notes, parent.id, "first", context)).toEqual({ text: "later" });
		} finally {
			await session.close(context);
		}
	});

	test.each([State, Current])(
		"changing the selected parent document rejects the whole fork: $definition.kind",
		async (token) => {
			const session = createSession(await open());
			try {
				const { parent, point } = await populate(session);
				await expect(
					session.commit(async (tx) => {
						await tx.forkConversation(parent.id, point.id, { ownership: { kind: "ownerless" } });
						(await tx.doc(token, parent.id)).count++;
					}, context),
				).rejects.toThrow(/Cannot (change fork source|fork conversation)/);
				const conversations = await session.commit((tx) => tx.scanConversations({}, 10), context);
				expect(conversations.items.map((record) => record.id)).toEqual([parent.id]);
				expect(await session.snapshot(token, parent.id, context)).toEqual({ count: 9 });
				await session.commit(async (tx) => {
					(await tx.doc(token, parent.id)).count = 11;
				}, context);
				expect(await session.snapshot(token, parent.id, context)).toEqual({ count: 11 });
			} finally {
				await session.close(context);
			}
		},
	);
});

test.each(["missing", "scope", "kind", "key", "history", "fork"] as const)(
	"an unreadable or mismatched fork source aborts the copy: %s",
	async (fault) => {
		class Storage extends MemoryStorage {
			fault = false;
			override async document(...args: Parameters<MemoryStorage["document"]>) {
				const stored = await super.document(...args);
				if (!this.fault || !stored || stored.record.kind !== State.definition.kind) return stored;
				if (fault === "missing") return undefined;
				const record = stored.record;
				if (record.scope.kind !== "conversation") throw new Error("The fixture source must be a conversation document");
				switch (fault) {
					case "scope":
						return {
							...stored,
							record: {
								id: record.id,
								kind: record.kind,
								createdAt: record.createdAt,
								scope: { kind: "session" as const },
							},
						};
					case "kind":
						return { ...stored, record: { ...record, kind: "another-kind" } };
					case "key":
						return { ...stored, record: { ...record, key: "another-key" } };
					case "history":
						return {
							...stored,
							record: { ...record, scope: record.scope, history: "latest" as const, fork: "current" as const },
						};
					case "fork":
						return {
							...stored,
							record: { ...record, scope: record.scope, history: "rewindable" as const, fork: "initial" as const },
						};
				}
			}
		}
		const storage = new Storage();
		const session = createSession(storage);
		try {
			const { parent, point } = await populate(session);
			storage.fault = true;
			await expect(
				session.commit(async (tx) => {
					const child = await tx.forkConversation(parent.id, point.id, { ownership: { kind: "ownerless" } });
					await tx.doc(State, child.id);
				}, context),
			).rejects.toThrow(/Fork source document.*(cannot be read|does not match)/);
			storage.fault = false;
			const conversations = await session.commit((tx) => tx.scanConversations({}, 10), context);
			expect(conversations.items.map((record) => record.id)).toEqual([parent.id]);
			expect(await session.snapshot(State, parent.id, context)).toEqual({ count: 9 });
		} finally {
			await session.close(context);
		}
	},
);
