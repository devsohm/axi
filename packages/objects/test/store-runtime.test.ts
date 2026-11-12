import { LiveQueries } from "../src/store/live-query.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
	BACKGROUND_CONTEXT as context,
	withCancel,
	type Context,
} from "../src/context/index.ts";
import { sqliteBackend } from "../src/store/backend.ts";
import { createDocument, loadContent } from "../src/store/engine.ts";
import { openStore, type ObjectsStore } from "../src/store/store.ts";
import { openNodeSqliteDatabase } from "../src/sqlite/node.ts";
import { str } from "../src/contracts/index.ts";
import { defineTable } from "../src/store/table.ts";
import { evolveTable } from "../src/store/table-evolve.ts";
import { TableHandle } from "../src/store/table-handle.ts";
import { prepareTables } from "../src/store/table-migration.ts";
import { TableChanges } from "../src/store/table-changes.ts";
import type { StagedWrite } from "../src/store/step.ts";
import { and } from "../src/store/expression.ts";
import type { StoreWrite } from "../src/store/writes.ts";

const fence = { admit: () => true, adopt: () => {} };

it("opens the store with the selected outbox setting", async () => {
	let reads = 0;
	const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context, {
		get outbox() {
			return ++reads === 1;
		},
	});
	try {
		expect(store.outbox).toBeDefined();
		expect(await store.outbox?.read(0, 10, context)).toEqual([]);
	} finally {
		await store.close(context);
	}
});

it("uses the selected cancellation signal to classify a failed read", async () => {
	const store = (await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context)) as ObjectsStore;
	const cancelled = AbortSignal.abort(new Error("Caller stopped waiting"));
	let reads = 0;
	const caller: Context = {
		get abortSignal() {
			return ++reads === 1 ? cancelled : undefined;
		},
		telemetry: context.telemetry,
		value: key => context.value(key),
		toString: () => "cancelled store read",
	};
	try {
		await expect(store.read(async () => {
			throw new Error("Read interrupted");
		}, caller)).rejects.toMatchObject({
			code: "aborted",
			cause: cancelled.reason,
		});
		expect(await store.read(async () => "available", context)).toBe("available");
	} finally {
		await store.close(context);
	}
});

it("counts rows during composite writes and adopts the total once", async () => {
	const store = (await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context)) as ObjectsStore;
	const definition = defineTable("notes", { version: 1, columns: { id: str(), text: str() }, key: ["id"] });
	const owner = { label: "app", scope: {}, queries: new LiveQueries(), assertLive() {}, fail(error: Error) { throw error; } };
	try {
		await prepareTables([{ definition, table: "app:notes" }], store, fence, "app", context);
		const writes: StagedWrite[] = [];
		const changes = new TableChanges(new TableHandle(definition, "app:notes", store, owner), writes);
		changes.put({ id: "a", text: "first" });
		changes.put({ id: "b", text: "second" });
		changes.update({ id: "a" }, { text: "updated" });
		changes.delete({ id: "b" });
		changes.updateWhere(and(), { text: "bulk" });
		changes.deleteWhere(and());
		changes.delete({ id: "absent" });
		const counts: number[] = [];
		await store.commit([{
			order: "write",
			async apply(step) {
				const recorded: StoreWrite[] = [];
				for (const write of writes) {
					recorded.push(...await write.apply(step));
					counts.push(step.rows);
				}
				return recorded;
			},
		}], {
			admit: () => true,
			adopt: (_seq, _ids, rows) => expect(rows).toBe(6),
		}, context);
		expect(counts).toEqual([1, 2, 3, 4, 5, 6, 6]);
	} finally {
		await store.close(context);
	}
});

it("preserves rows through a column rename and refuses obsolete table handles", async () => {
	const store = (await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context)) as ObjectsStore;
	const first = defineTable("messages", { version: 1, columns: { id: str(), text: str() }, key: ["id"] });
	const second = evolveTable(first, table => table.rename("text", "body"));
	const owner = { label: "workspace", scope: {}, queries: new LiveQueries(), assertLive() {}, fail(error: Error) { throw error; } };
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
it("announces grouped commits only after adoption and removes failing observers without undoing storage", async () => {
	const store = (await openStore(
		sqliteBackend(await openNodeSqliteDatabase(":memory:")),
		context,
	)) as ObjectsStore;
	const adopted: number[] = [],
		seen: number[] = [],
		errors: unknown[] = [];
	const failure = new Error("observer failed");
	let failingCalls = 0;
	const remove = store.onCommitted(
		(seq) => {
			expect(adopted.at(-1)).toBe(seq);
			seen.push(seq);
		},
		(error) => {
			throw error;
		},
	);
	store.onCommitted(
		() => {
			failingCalls++;
			throw failure;
		},
		(error) => {
			errors.push(error);
		},
	);
	try {
		const commitFence = {
			admit: () => true,
			adopt: (seq: number) => {
				adopted.push(seq);
			},
		};
		await Promise.all([
			store.commit([create("one")], commitFence, context),
			store.commit([create("two")], commitFence, context),
		]);
		expect([adopted, seen, errors, failingCalls]).toEqual([[1, 2], [2], [failure], 1]);
		await store.commit([create("three")], commitFence, context);
		expect(seen).toEqual([2, 3]);
		remove();
		await store.commit([create("four")], commitFence, context);
		expect([seen, failingCalls, store.lastSeq]).toEqual([[2, 3], 1, 4]);
	} finally {
		await store.close(context);
	}
});

it("leaves commit observers quiet for empty work and a rolled-back write", async () => {
	const store = (await openStore(
		sqliteBackend(await openNodeSqliteDatabase(":memory:")),
		context,
	)) as ObjectsStore;
	const seen: number[] = [];
	store.onCommitted(
		(seq) => {
			seen.push(seq);
		},
		(error) => {
			throw error;
		},
	);
	try {
		await store.commit([], fence, context);
		await expect(
			store.commit(
				[
					{
						order: "write",
						async apply() {
							throw new Error("refused");
						},
					},
				],
				fence,
				context,
			),
		).rejects.toThrow("refused");
		expect(seen).toEqual([]);
		await store.commitSeries([{ check: async () => {}, writes: [create("series")] }], () => {}, context);
		expect(seen).toEqual([1]);
	} finally {
		await store.close(context);
	}
});
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
