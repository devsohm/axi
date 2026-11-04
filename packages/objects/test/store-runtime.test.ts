import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
	BACKGROUND_CONTEXT as context,
	withCancel,
} from "../src/context/index.ts";
import { sqliteBackend } from "../src/next/store/backend.ts";
import { createDocument, loadContent } from "../src/next/store/engine.ts";
import { openStore, type ObjectsStore } from "../src/next/store/store.ts";
import { openNodeSqliteDatabase } from "../src/sqlite/node.ts";
import { str } from "../src/next/contracts/index.ts";
import { defineTable } from "../src/next/store/table.ts";
import { evolveTable } from "../src/next/store/table-evolve.ts";
import { TableHandle } from "../src/next/store/table-handle.ts";
import { prepareTables } from "../src/next/store/table-migration.ts";
import { TableChanges } from "../src/next/store/table-changes.ts";
import type { StagedWrite } from "../src/next/store/step.ts";

const fence = { admit: () => true, adopt: () => {} };

it("preserves rows through a column rename and refuses obsolete table handles", async () => {
	const store = (await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context)) as ObjectsStore;
	const first = defineTable("messages", { version: 1, columns: { id: str(), text: str() }, key: ["id"] });
	const second = evolveTable(first, table => table.rename("text", "body"));
	const owner = { label: "workspace", scope: {}, assertLive() {}, fail(error: Error) { throw error; } };
	try {
		await prepareTables([{ definition: first, table: "workspace:messages" }], store, fence, "workspace", context);
		const old = new TableHandle(first, "workspace:messages", store, owner);
		const writes: StagedWrite[] = [];
		new TableChanges(old, writes).put({ id: "welcome", text: "hello" });
		await store.commit(writes, fence, context);
		await prepareTables([{ definition: second, table: "workspace:messages" }], store, fence, "workspace", context);
		const current = new TableHandle(second, "workspace:messages", store, owner);
		expect(await current.get({ id: "welcome" }, context)).toEqual({ id: "welcome", body: "hello" });
		await expect(old.get({ id: "welcome" }, context)).rejects.toMatchObject({ code: "released", reason: "version" });
		expect(store.tableVersion("workspace:messages")).toBe(2);
	} finally {
		await store.close(context);
	}
});
const create = (key: string) =>
	createDocument(
		{ owner: "app", namespace: "notes", kind: "entry", key },
		{ version: 1, fingerprint: "one", value: { key } },
		JSON.stringify({ key }),
	);
it("lets an admitted outbox trim finish while close waits for it", async () => {
	const db = await openNodeSqliteDatabase(":memory:");
	const store = (await openStore(sqliteBackend(db), context, { outbox: true })) as ObjectsStore;
	const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
	try {
		await store.commit([create("a")], fence, context);
		const transaction = db.transaction.bind(db);
		db.transaction = async work => {
			const result = await transaction(work);
			entered.resolve();
			await release.promise;
			return result;
		};
		const trimming = store.outbox!.trim(1, context);
		await entered.promise;
		const closing = store.close(context);
		release.resolve();
		await expect(trimming).resolves.toBeUndefined();
		await closing;
		expect(store.outbox!.floor).toBe(1);
	} finally {
		release.resolve();
		await store.close(context);
	}
});
it("reopens the committed sequence and allocator, and keeps outbox reads consistent with concurrent trims", async () => {
	const directory = await mkdtemp(join(tmpdir(), "axi-store-"));
	const file = join(directory, "state.sqlite");
	let store = (await openStore(
		sqliteBackend(await openNodeSqliteDatabase(file)),
		context,
		{ outbox: true },
	)) as ObjectsStore;
	try {
		await Promise.all([
			store.commit([create("a")], fence, context),
			store.commit([create("b")], fence, context),
		]);
		expect(
			(await store.outbox!.read(0, 10, context)).map((commit) => [
				commit.seq,
				commit.nextId,
			]),
		).toEqual([
			[1, 3],
			[2, 4],
		]);
		await store.close(context);
		store = (await openStore(
			sqliteBackend(await openNodeSqliteDatabase(file)),
			context,
		)) as ObjectsStore;
		expect([store.lastSeq, store.mintId()]).toEqual([2, 4]);
		expect(
			(await store.read((db) => loadContent(db, 2, "current"), context)).value,
		).toEqual({ key: "a" });
		await Promise.all([
			store.outbox!.trim(2, context),
			store.outbox!.trim(1, context),
		]);
		expect(store.outbox!.floor).toBe(2);
		await expect(store.outbox!.read(1, 10, context)).rejects.toMatchObject({
			code: "invalid",
			reason: "args",
		});
	} finally {
		await store.close(context);
		await rm(directory, { recursive: true, force: true });
	}
});
it("releases an export's commit lock immediately on cancellation", async () => {
	const store = (await openStore(
		sqliteBackend(await openNodeSqliteDatabase(":memory:")),
		context,
	)) as ObjectsStore;
	try {
		await store.commit([create("a")], fence, context);
		const cancel = withCancel(context),
			exported = store.export(cancel.context);
		expect((await exported.next()).value).toMatchObject({
			kind: "manifest",
			lastSeq: 1,
		});
		let adopted = false;
		const pending = store.commit(
			[create("b")],
			{
				admit: () => true,
				adopt: () => {
					adopted = true;
				},
			},
			context,
		);
		await Promise.resolve();
		expect(adopted).toBe(false);
		cancel.cancel();
		expect(await pending).toBe(2);
		await expect(exported.next()).rejects.toMatchObject({ code: "aborted" });
	} finally {
		await store.close(context);
	}
});
it("continues after a rolled-back refusal and stops after an uncertain commit outcome", async () => {
	const db = await openNodeSqliteDatabase(":memory:"),
		store = (await openStore(sqliteBackend(db), context)) as ObjectsStore;
	try {
		const refusal = new Error("rejected input");
		await expect(
			store.commit(
				[
					{
						order: "write",
						apply: async () => {
							throw refusal;
						},
					},
				],
				fence,
				context,
			),
		).rejects.toBe(refusal);
		expect(await store.commit([create("a")], fence, context)).toBe(1);
		const transaction = db.transaction.bind(db);
		db.transaction = async (work) => {
			await transaction(work);
			throw new Error("lost commit acknowledgement");
		};
		await expect(
			store.commit([create("b")], fence, context),
		).rejects.toMatchObject({ code: "unavailable", reason: "storage_failed" });
		await expect(store.read(async () => 1, context)).rejects.toMatchObject({
			reason: "storage_failed",
		});
	} finally {
		await store.close(context);
	}
});
