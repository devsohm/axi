import { BACKGROUND_CONTEXT as context } from "@axi/objects/context";
import { expect, test } from "vitest";
import { defineEntry, MemoryStorage, type CommitPublication, type EntryId, type ReportInfo } from "../src/index.ts";
import { SessionImpl } from "../src/session/session.ts";

const Receipt = defineEntry<{ count: number }>("scope.receipt");

class ScopedStorage extends MemoryStorage {
	scope: (publish: () => void) => void = (publish) => publish();
	publishing(publish: () => void): void {
		this.scope(publish);
	}
}

class ReportingSession extends SessionImpl {
	readonly reports: { error: unknown; info: ReportInfo }[] = [];
	override report(error: unknown, info: ReportInfo = { kind: "listener_error" }): void {
		this.reports.push({ error, info });
	}
}

test("storage publication defers settlement, dependent reads and observers until its callback runs", async () => {
	const storage = new ScopedStorage(),
		session = new ReportingSession(storage);
	const entered = Promise.withResolvers<() => void>(),
		admitted = Promise.withResolvers<EntryId>();
	const published: CommitPublication[] = [];
	let release: (() => void) | undefined;
	try {
		const conversation = await session.commit(
			(tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
			context,
		);
		session.observeCommits({ advance: (frame) => published.push(frame), end() {} });
		storage.scope = (publish) => entered.resolve(publish);
		let settled = false,
			readSettled = false;
		const writing = session
			.commit(async (tx) => {
				const entry = await tx.appendEntry(conversation.id, { kind: Receipt.kind, data: { count: 1 } });
				admitted.resolve(entry.id);
				return entry;
			}, context)
			.then((entry) => {
				settled = true;
				return entry;
			});
		const id = await admitted.promise;
		release = await entered.promise;
		const reading = session
			.commit((tx) => tx.entry(Receipt, id), context)
			.then((entry) => {
				readSettled = true;
				return entry;
			});
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect((await storage.entry(id, context))?.entry.data).toEqual({ count: 1 });
		expect({ settled, readSettled, published }).toEqual({ settled: false, readSettled: false, published: [] });
		storage.scope = (publish) => publish();
		release();
		const [written, read] = await Promise.all([writing, reading]);
		expect(read).toEqual(written);
		expect(published).toMatchObject([{ changes: [{ type: "entry", value: { id, data: { count: 1 } } }] }]);
		release();
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(published).toHaveLength(1);
		expect(session.reports).toEqual([]);
	} finally {
		storage.scope = (publish) => publish();
		release?.();
		await session.close(context);
	}
});

test.each(["throw-before", "throw-after", "duplicate"] as const)(
	"a %s publication scope adopts its durable entry once and leaves the session usable",
	async (mode) => {
		const failure = new Error("Publication scope failed"),
			storage = new ScopedStorage();
		const session = new ReportingSession(storage),
			published: CommitPublication[] = [];
		try {
			const conversation = await session.commit(
				(tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
				context,
			);
			session.observeCommits({ advance: (frame) => published.push(frame), end() {} });
			storage.scope = (publish) => {
				if (mode === "throw-before") throw failure;
				publish();
				if (mode === "throw-after") throw failure;
				publish();
			};
			const entry = await session.commit(
				(tx) => tx.appendEntry(conversation.id, { kind: Receipt.kind, data: { count: 1 } }),
				context,
			);
			expect(published).toMatchObject([{ changes: [{ type: "entry", value: { id: entry.id } }] }]);
			expect(session.reports).toEqual(
				mode === "duplicate" ? [] : [{ error: failure, info: { kind: "listener_error" } }],
			);
			storage.scope = (publish) => publish();
			await session.commit(
				(tx) => tx.appendEntry(conversation.id, { kind: Receipt.kind, data: { count: 2 } }),
				context,
			);
			expect(
				(
					await storage.scanEntries({ conversationId: conversation.id, order: "ascending" }, 10, undefined, context)
				).items.map((entry) => entry.data),
			).toEqual([{ count: 1 }, { count: 2 }]);
			expect(published).toHaveLength(2);
		} finally {
			storage.scope = (publish) => publish();
			await session.close(context);
		}
	},
);

test("a late publication cannot expose stored data through an already failed session", async () => {
	const storage = new ScopedStorage(),
		session = new ReportingSession(storage);
	const entered = Promise.withResolvers<() => void>();
	const published: CommitPublication[] = [];
	let release: (() => void) | undefined;
	try {
		const conversation = await session.commit(
			(tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
			context,
		);
		session.observeCommits({ advance: (frame) => published.push(frame), end() {} });
		storage.scope = (publish) => entered.resolve(publish);
		const writing = session.commit(
			(tx) => tx.appendEntry(conversation.id, { kind: Receipt.kind, data: { count: 1 } }),
			context,
		);
		const failure = new Error("Session failed during publication");
		const rejected = expect(writing).rejects.toMatchObject({ name: "SessionFailed", cause: failure });
		release = await entered.promise;
		expect(
			(await storage.scanEntries({ conversationId: conversation.id }, 10, undefined, context)).items.map(
				(entry) => entry.data,
			),
		).toEqual([{ count: 1 }]);
		session.fail(failure);
		release();
		await rejected;
		expect(published).toEqual([]);
		await session.close(context);
		expect(await session.closed).toEqual({ kind: "failed", error: failure });
		await expect(storage.scanEntries({ conversationId: conversation.id }, 10, undefined, context)).rejects.toThrow(
			/closed/,
		);
	} finally {
		storage.scope = (publish) => publish();
		release?.();
		await session.close(context);
	}
});

test("deferred persistence does not postpone a record write", async () => {
	const storage = new ScopedStorage(),
		session = new ReportingSession(storage);
	const published: CommitPublication[] = [];
	try {
		const conversation = await session.commit(
			(tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
			context,
		);
		session.observeCommits({ advance: (frame) => published.push(frame), end() {} });
		const entry = await session.commit(
			(tx) => tx.appendEntry(conversation.id, { kind: Receipt.kind, data: { count: 1 } }),
			context,
			{ persistence: { kind: "deferred", withinMs: Infinity } },
		);
		expect((await storage.entry(entry.id, context))?.entry).toEqual(entry);
		expect(published).toMatchObject([{ changes: [{ type: "entry", value: { id: entry.id } }] }]);
	} finally {
		await session.close(context);
	}
});
