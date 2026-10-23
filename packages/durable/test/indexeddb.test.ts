import { IDBObjectStore, IDBKeyRange, IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as context } from "@axi/chord/context";
import { IndexedDbStorage } from "../src/storage/indexeddb.ts";
import { registerStorageConformance } from "../src/testing/index.ts";
import type { Storage, EntryId, DocumentId } from "../src/types.ts";
import { ROOT_CONVERSATION_ID } from "../src/types.ts";

Object.defineProperty(globalThis, "IDBKeyRange", { configurable: true, value: IDBKeyRange });

it("persists the database stores, metadata and indexed record envelope", async () => {
	const indexedDB = new IDBFactory();
	const storage = await IndexedDbStorage.open("schema", { indexedDB });
	await storage.commit([{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], () => {}, context);
	await storage.close(context);
	const database = await new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open("schema");
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
	try {
		expect([...database.objectStoreNames]).toEqual([
			"conversations",
			"document_revisions",
			"documents",
			"entries",
			"meta",
			"record_ids",
			"submissions",
			"tasks",
		]);
		const tx = database.transaction(["conversations", "meta", "record_ids"], "readonly");
		const values = await Promise.all(
			["meta", "conversations", "record_ids"].map(
				(name) =>
					new Promise((resolve, reject) => {
						const request = tx.objectStore(name).getAll();
						request.onsuccess = () => resolve(request.result);
						request.onerror = () => reject(request.error);
					}),
			),
		);
		expect(values).toEqual([
			[{ key: "state", nextId: 2, nextSeq: 2 }],
			[{ id: 1, record: { id: 1 } }],
			[{ id: 1, recordType: "conversation" }],
		]);
	} finally {
		database.close();
	}
});

it("deletes a closed database so reopening creates fresh allocation counters", async () => {
	const options = { indexedDB: new IDBFactory() };
	const storage = await IndexedDbStorage.open("delete", options);
	expect(await storage.mintId<EntryId>()).toBe(2);
	await storage.close(context);
	await IndexedDbStorage.delete("delete", options);
	const fresh = await IndexedDbStorage.open("delete", options);
	try {
		expect(await fresh.mintId<EntryId>()).toBe(2);
	} finally {
		await fresh.close(context);
	}
});

for (const reopen of [false, true])
	registerStorageConformance({ describe, expect, it }, `IndexedDB ${reopen ? "reopened" : "open"}`, async (use) => {
		const indexedDB = new IDBFactory();
		let current = await IndexedDbStorage.open("storage", { indexedDB });
		let closed = false;
		const storage: Storage = new Proxy(current, {
			get(_target, property) {
				if (property === "close")
					return async () => {
						closed = true;
						await current.close(context);
					};
				if (property === "commit" && reopen && !closed)
					return async (...args: Parameters<Storage["commit"]>) => {
						try {
							return await current.commit(...args);
						} finally {
							await current.close(context);
							current = await IndexedDbStorage.open("storage", { indexedDB });
						}
					};
				const method = Reflect.get(current, property);
				return typeof method === "function" ? method.bind(current) : method;
			},
		});
		try {
			await use(storage);
		} finally {
			await current.close(context);
		}
	});

it("allocates unique IDs across clients, preserves counters after reopening and observes committed writes", async () => {
	const indexedDB = new IDBFactory(),
		options = { indexedDB };
	const one = await IndexedDbStorage.open("concurrent", options),
		two = await IndexedDbStorage.open("concurrent", options);
	try {
		const ids = await Promise.all(Array.from({ length: 40 }, (_, index) => (index % 2 ? one : two).mintId<EntryId>()));
		expect(new Set(ids).size).toBe(40);
		expect([...ids].sort((a, b) => a - b)).toEqual(Array.from({ length: 40 }, (_, index) => index + 2));
		await one.commit([{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], () => {}, context);
		expect(await two.conversation(ROOT_CONVERSATION_ID, context)).toEqual({ id: ROOT_CONVERSATION_ID });
	} finally {
		await one.close(context);
		await two.close(context);
	}
	const reopened = await IndexedDbStorage.open("concurrent", options);
	try {
		expect(await reopened.mintId<EntryId>()).toBe(42);
	} finally {
		await reopened.close(context);
	}
});

it("rolls back early writes and the sequence when a later document command fails", async () => {
	const storage = await IndexedDbStorage.open("rollback", { indexedDB: new IDBFactory() });
	try {
		const id = await storage.mintId<EntryId>(),
			absent = await storage.mintId<DocumentId>();
		await expect(
			storage.commit(
				[
					{ type: "entry", value: { id, conversationId: ROOT_CONVERSATION_ID, kind: "text" } },
					{ type: "document.retire", id: absent },
				],
				() => {},
				context,
			),
		).rejects.toThrow();
		expect(await storage.entry(id, context)).toBeUndefined();
		expect(
			await storage.commit([{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], () => {}, context),
		).toBe(1);
	} finally {
		await storage.close(context);
	}
});

it("returns a descending page without reading every fork ancestor", async () => {
	const storage = await IndexedDbStorage.open("paged-ancestry", { indexedDB: new IDBFactory() });
	try {
		let conversation = ROOT_CONVERSATION_ID;
		await storage.commit([{ type: "conversation", value: { id: conversation } }], () => {}, context);
		for (let index = 0; index < 20; index++) {
			const at = await storage.mintId<EntryId>();
			await storage.commit(
				[{ type: "entry", value: { id: at, conversationId: conversation, kind: "point" } }],
				() => {},
				context,
			);
			const next = await storage.mintId<import("../src/types.ts").ConversationId>();
			await storage.commit(
				[{ type: "conversation", value: { id: next, parent: { conversationId: conversation, at } } }],
				() => {},
				context,
			);
			conversation = next;
		}
		const ids = await Promise.all(Array.from({ length: 3 }, () => storage.mintId<EntryId>()));
		await storage.commit(
			ids.map((id) => ({ type: "entry", value: { id, conversationId: conversation, kind: "recent" } })),
			() => {},
			context,
		);
		const reads = vi.spyOn(IDBObjectStore.prototype, "get");
		try {
			const page = await storage.scanEntries({ conversationId: conversation }, 1, undefined, context);
			expect(page.items.map((entry) => entry.id)).toEqual([ids[2]]);
			expect(page.next).toEqual({ after: ids[2], order: "descending" });
			expect(reads.mock.calls).toHaveLength(1);
		} finally {
			reads.mockRestore();
		}
	} finally {
		await storage.close(context);
	}
});
