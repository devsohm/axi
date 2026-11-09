import { commitWrites } from "../src/testing/commit-writes.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@axi/objects/context";
import type { SqliteExecutor } from "@axi/objects/sqlite";
import { describe, expect, it, vi } from "vitest";
import {
	createSession,
	defineDoc,
	ROOT_CONVERSATION_ID,
	type ConversationId,
	type EntryId,
	type StorageWrite,
} from "../src/index.ts";
import { idFromNumber } from "../src/ids.ts";
import { openNodeSqliteDatabase, openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { SqliteStorage } from "../src/storage/sqlite/storage.ts";

const State = defineDoc({
	checkpointWhen: () => false,
	kind: "state",
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	version: 1,
	initial: () => ({ count: 0, items: [] as string[] }),
});
describe("SQLite-backed Session", () => {
	it("keeps grouped entry writes bounded and stops receipts at the first refusal", async () => {
		const database = await openNodeSqliteDatabase(":memory:");
		const storage = await SqliteStorage.open(database);
		const transaction = database.transaction.bind(database);
		let calls = 0;
		vi.spyOn(database, "transaction").mockImplementation(
			<Value>(callback: (executor: SqliteExecutor) => Promise<Value>) =>
				transaction(async (executor) => {
					const run = executor.run.bind(executor);
					const get = executor.get.bind(executor);
					const all = executor.all.bind(executor);
					return callback({
						...executor,
						exec: (sql) => executor.exec(sql),
						runCounted: (sql, ...params) => executor.runCounted(sql, ...params),
						run: (sql, ...params) => {
							calls++;
							return run(sql, ...params);
						},
						get: (sql, ...params) => {
							calls++;
							return get(sql, ...params);
						},
						all: (sql, ...params) => {
							calls++;
							return all(sql, ...params);
						},
					});
				}),
		);
		try {
			const write = (id: number): StorageWrite => ({
				type: "entry",
				value: { id: idFromNumber<EntryId>(id), conversationId: ROOT_CONVERSATION_ID, kind: "note" },
			});
			await storage.commit([[write(2)]], () => {}, context);
			const single = calls;
			calls = 0;
			const receipts: number[] = [];
			await storage.commit(
				Array.from({ length: 64 }, (_, index) => [write(index + 3)]),
				(_, seq) => receipts.push(seq),
				context,
			);
			expect(calls).toBe(single);
			expect(receipts).toHaveLength(64);
			const kept: number[] = [];
			expect(
				await storage.commit([[write(80)], [write(80)], [write(81)]], (index) => kept.push(index), context),
			).toMatchObject({ stored: 1, refused: expect.any(Error) });
			expect(kept).toEqual([0]);
			expect(await storage.entry(idFromNumber<EntryId>(80), context)).toBeDefined();
			expect(await storage.entry(idFromNumber<EntryId>(81), context)).toBeUndefined();
		} finally {
			await storage.close(context);
		}
	});
	it("keeps in-flight ID allocations in memory and reopens at the committed boundary", async () => {
		const directory = await mkdtemp(join(tmpdir(), "axi-id-allocation-"));
		const path = join(directory, "session.sqlite");
		const database = await openNodeSqliteDatabase(path);
		let storage = await SqliteStorage.open(database);
		const transaction = database.transaction.bind(database);
		vi.spyOn(database, "transaction").mockImplementation(
			<Value>(callback: (executor: SqliteExecutor) => Promise<Value>) =>
				transaction(async (executor) => {
					const run = executor.run.bind(executor);
					executor.run = async (sql, ...params) => {
						await run(sql, ...params);
						if (/INSERT INTO entries\b/.test(sql)) {
							for (let index = 0; index < 3; index++) await storage.mintId<EntryId>();
						}
					};
					return callback(executor);
				}),
		);
		try {
			const id = await storage.mintId<EntryId>();
			await commitWrites(
				storage,
				[{ type: "entry", value: { id, conversationId: ROOT_CONVERSATION_ID, kind: "note" } }],
				context,
			);
			expect(await storage.mintId<EntryId>()).toBe(id + 4);
			await storage.close(context);
			storage = await openNodeSqliteStorage(path);
			expect(await storage.mintId<EntryId>()).toBe(id + 1);
			expect((await storage.entry(id, context))?.entry.id).toBe(id);
		} finally {
			await storage.close(context);
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("preserves initialization errors when closing the database throws synchronously", async () => {
		const failure = new Error("initialization failed");
		const database = {
			exec: vi.fn(async () => {}),
			run: vi.fn(async () => {}),
			runCounted: vi.fn(async () => 0),
			get: vi.fn(async () => undefined),
			all: vi.fn(async () => []),
			transaction: vi.fn(async () => {
				throw failure;
			}),
			close: vi.fn(() => {
				throw new Error("close failed");
			}),
		};
		await expect(SqliteStorage.open(database)).rejects.toBe(failure);
		expect(database.close).toHaveBeenCalledTimes(1);
	});
	it("fills a descending page without reading ancestors it does not need", async () => {
		const database = await openNodeSqliteDatabase(":memory:");
		const storage = await SqliteStorage.open(database);
		try {
			const writes: StorageWrite[] = [];
			for (let level = 0; level <= 20; level++) {
				const id = idFromNumber<ConversationId>(level * 2 + 2);
				writes.push({
					type: "conversation",
					value: {
						id,
						...(level
							? { parent: { conversationId: idFromNumber<ConversationId>(id - 2), at: idFromNumber<EntryId>(id - 1) } }
							: {}),
					},
				});
				writes.push({ type: "entry", value: { id: idFromNumber<EntryId>(id + 1), conversationId: id, kind: "note" } });
			}
			const leaf = idFromNumber<ConversationId>(42);
			writes.push({ type: "entry", value: { id: idFromNumber<EntryId>(44), conversationId: leaf, kind: "note" } });
			await commitWrites(storage, writes, context);
			const reads = vi.spyOn(database, "get");
			const page = await storage.scanEntries({ conversationId: leaf }, 1, undefined, context);
			expect(page.items.map((item) => item.id)).toEqual([44]);
			expect(page.next).toBeDefined();
			expect(
				reads.mock.calls.filter(([sql]) => /SELECT record\s+FROM conversations\s+WHERE id\s*=/.test(sql)),
			).toHaveLength(1);
		} finally {
			await storage.close(context);
		}
	});
	it("recovers document history and forks through the public Session API", async () => {
		const directory = await mkdtemp(join(tmpdir(), "axi-session-"));
		const path = join(directory, "session.sqlite");
		let session = createSession(await openNodeSqliteStorage(path));
		try {
			const conversation = await session.commit(
				(tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
				context,
			);
			const first = await session.commit(async (tx) => {
				const state = await tx.doc(State, conversation.id);
				state.count = 1;
				state.items.push("first");
				return tx.appendEntry(conversation.id, { kind: "point" });
			}, context);
			await session.commit(async (tx) => {
				(await tx.doc(State, conversation.id)).count = 2;
			}, context);
			await session.close(context);
			session = createSession(await openNodeSqliteStorage(path));
			expect(await session.snapshot(State, conversation.id, context)).toEqual({ count: 2, items: ["first"] });
			expect(await session.snapshotAsOf(State, conversation.id, first.id, context)).toEqual({
				count: 1,
				items: ["first"],
			});
			const fork = await session.commit(
				(tx) => tx.forkConversation(conversation.id, first.id, { ownership: { kind: "ownerless" } }),
				context,
			);
			await expect(
				session.commit(async (tx) => {
					(await tx.doc(State, fork.id)).count = 99;
					throw new Error("rollback");
				}, context),
			).rejects.toThrow("rollback");
			await session.close(context);
			session = createSession(await openNodeSqliteStorage(path));
			expect(await session.snapshot(State, fork.id, context)).toEqual({ count: 1, items: ["first"] });
		} finally {
			await session.close(context);
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("keeps the committed ID allocator unchanged after a rejected batch", async () => {
		const storage = await openNodeSqliteStorage(":memory:");
		try {
			const id = 100 as EntryId;
			await expect(
				commitWrites(
					storage,
					[
						{ type: "entry", value: { id, conversationId: ROOT_CONVERSATION_ID, kind: "a" } },
						{ type: "entry", value: { id, conversationId: ROOT_CONVERSATION_ID, kind: "b" } },
					],
					context,
				),
			).rejects.toThrow("written more than once");
			expect(await storage.mintId<EntryId>()).toBe(2);
			expect(
				await commitWrites(
					storage,
					[{ type: "entry", value: { id, conversationId: ROOT_CONVERSATION_ID, kind: "kept" } }],
					context,
				),
			).toBe(1);
			expect(await storage.mintId<EntryId>()).toBe(101);
			expect((await storage.entry(id, context))?.entry.kind).toBe("kept");
		} finally {
			await storage.close(context);
		}
	});
});
