import { commitWrites } from "../src/testing/commit-writes.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@axi/objects/context";
import { openStore, sqliteBackend, type Store } from "@axi/objects/next";
import { openNodeSqliteDatabase } from "@axi/objects/sqlite/node";
import { describe, expect, it } from "vitest";
import { idFromNumber } from "../src/ids.ts";
import { ROOT_CONVERSATION_ID, type EntryId, type Storage } from "../src/types.ts";
import { StoreStorage } from "../src/storage/store/index.ts";
import { registerStorageConformance } from "../src/testing/index.ts";

registerStorageConformance({ describe, expect, it }, "shared Store storage", async (use) => {
	const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context);
	const storage = await StoreStorage.open(store, "test", context);
	try {
		await use(storage);
	} finally {
		await storage.close(context);
		await store.close(context);
	}
});
registerStorageConformance({ describe, expect, it }, "shared Store storage after every commit reopens", async (use) => {
	const directory = await mkdtemp(join(tmpdir(), "axi-store-storage-")),
		file = join(directory, "session.sqlite");
	let store: Store, current: Storage;
	const open = async (): Promise<void> => {
		store = await openStore(sqliteBackend(await openNodeSqliteDatabase(file)), context);
		current = await StoreStorage.open(store, "test", context);
	};
	await open();
	let closed = false;
	const close = async (): Promise<void> => {
		await current.close(context);
		await store.close(context);
	};
	const commit: Storage["commit"] = async (writes, adopt, ctx) => {
		if (closed) return current.commit(writes, adopt, ctx);
		try {
			return await current.commit(writes, adopt, ctx);
		} finally {
			await close();
			await open();
		}
	};
	const facade = new Proxy(current!, {
		get(_target, property) {
			if (property === "commit") return commit;
			if (property === "close")
				return async () => {
					if (!closed) {
						closed = true;
						await close();
					}
				};
			const value: unknown = Reflect.get(current, property, current);
			return typeof value === "function" ? value.bind(current) : value;
		},
	});
	try {
		await use(facade);
	} finally {
		await facade.close(context);
		await rm(directory, { recursive: true, force: true });
	}
});
it("isolates owners, releases claims on close, and leaves the application-owned Store open", async () => {
	const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context);
	try {
		const first = await StoreStorage.open(store, "one", context),
			second = await StoreStorage.open(store, "two", context);
		await expect(StoreStorage.open(store, "one", context)).rejects.toMatchObject({ code: "invalid", reason: "args" });
		await commitWrites(first, [{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], context);
		expect(await second.conversation(ROOT_CONVERSATION_ID, context)).toBeUndefined();
		await first.close(context);
		const reopened = await StoreStorage.open(store, "one", context);
		expect(await reopened.conversation(ROOT_CONVERSATION_ID, context)).toEqual({
			id: ROOT_CONVERSATION_ID,
		});
		await reopened.close(context);
		await second.close(context);
	} finally {
		await store.close(context);
	}
});
it("keeps storage usable after request errors and preserves a refused-kind head marker", async () => {
	const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context),
		storage = await StoreStorage.open(store, "test", context);
	try {
		await expect(storage.scanEntries({ conversationId: idFromNumber(999) }, 4, undefined, context)).rejects.toThrow(
			"Unknown conversation",
		);
		await commitWrites(storage, [{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], context);
		const id = await storage.mintId<EntryId>();
		await commitWrites(
			storage,
			[
				{
					type: "entry",
					value: {
						id,
						conversationId: ROOT_CONVERSATION_ID,
						kind: "refused",
						head: id,
					},
				},
			],
			context,
		);
		expect((await storage.findLatestHeadMarker(ROOT_CONVERSATION_ID, undefined, context))?.id).toBe(id);
		expect(
			(await storage.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 4, undefined, context)).items.map(
				(entry) => entry.kind,
			),
		).toEqual(["refused"]);
	} finally {
		await storage.close(context);
		await store.close(context);
	}
});
