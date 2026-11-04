import { expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import { sqliteBackend } from "../src/store/backend.ts";
import { createDocument, findDocument } from "../src/store/engine.ts";
import {
	openStore,
	type ObjectsStore,
	type SeriesCommit,
} from "../src/store/store.ts";
import { openNodeSqliteDatabase } from "../src/sqlite/node.ts";

const address = {
	namespace: "notes",
	owner: "project",
	kind: "item",
	key: "one",
};
const create = (key: string): SeriesCommit => ({
	check: async () => {},
	writes: [
		createDocument(
			{ ...address, key },
			{ version: 1, fingerprint: "first", value: { key } },
			JSON.stringify({ key }),
		),
	],
});

it("stores an accepted prefix once and delivers receipts before the next queued write", async () => {
	const db = await openNodeSqliteDatabase(":memory:");
	const store = (await openStore(sqliteBackend(db), context)) as ObjectsStore;
	const transaction = db.transaction.bind(db);
	const events: string[] = [];
	db.transaction = async (work) => {
		events.push("begin");
		const result = await transaction(work);
		events.push("durable");
		return result;
	};
	try {
		expect("commitInBatch" in store).toBe(false);
		const refusal = new Error("not admitted");
		const series = store.commitSeries(
			[
				create("one"),
				{
					check: async (step) => {
						expect((await findDocument(step, address))?.id).toBe(2);
					},
					writes: [],
				},
				create("two"),
				{
					check: async () => {
						throw refusal;
					},
					writes: create("refused").writes,
				},
				create("never"),
			],
			(index, seq, ids) =>
				events.push(`receipt ${index} ${seq} ${ids.join(",")}`),
			context,
		);
		const next = store.commit(
			create("three").writes,
			{
				admit: () => true,
				adopt: (seq) => events.push(`next ${seq}`),
			},
			context,
		);
		expect(await series).toEqual({ stored: 3, refused: refusal });
		expect(await next).toBe(3);
		expect(events).toEqual([
			"begin",
			"durable",
			"receipt 0 1 2",
			"receipt 1 1 ",
			"receipt 2 2 3",
			"begin",
			"durable",
			"next 3",
		]);
		expect(
			await store.read(
				(sql) => sql.all("SELECT key FROM objects_documents ORDER BY id"),
				context,
			),
		).toEqual([{ key: "one" }, { key: "two" }, { key: "three" }]);
	} finally {
		await store.close(context);
	}
});

it("rolls back every write if a check hides a SQL error and then refuses", async () => {
	const store = (await openStore(
		sqliteBackend(await openNodeSqliteDatabase(":memory:")),
		context,
	)) as ObjectsStore;
	try {
		const refusal = new Error("check failed");
		const receipts: number[] = [];
		await expect(
			store.commitSeries(
				[
					create("one"),
					{
						check: async (step) => {
							await step.get("SELECT * FROM missing_table").catch(() => {});
							throw refusal;
						},
						writes: [],
					},
				],
				(index) => receipts.push(index),
				context,
			),
		).rejects.toBe(refusal);
		expect([receipts, store.lastSeq]).toEqual([[], 0]);
		expect(
			await store.read(
				(sql) => sql.all("SELECT key FROM objects_documents"),
				context,
			),
		).toEqual([]);
		const created: number[] = [];
		await store.commitSeries(
			[create("after")],
			(_index, seq, owned) => {
				expect(seq).toBe(1);
				created.push(...owned);
			},
			context,
		);
		expect(created).toEqual([3]);
	} finally {
		await store.close(context);
	}
});

it("stops after an uncertain transaction acknowledgement without issuing receipts", async () => {
	const db = await openNodeSqliteDatabase(":memory:");
	const store = (await openStore(sqliteBackend(db), context)) as ObjectsStore;
	const transaction = db.transaction.bind(db);
	db.transaction = async (work) => {
		await transaction(work);
		throw new Error("acknowledgement lost");
	};
	try {
		const receipts: number[] = [];
		await expect(
			store.commitSeries(
				[create("one"), create("two")],
				(index) => receipts.push(index),
				context,
			),
		).rejects.toMatchObject({ reason: "storage_failed" });
		expect(receipts).toEqual([]);
		await expect(
			store.commitSeries([create("after")], () => {}, context),
		).rejects.toMatchObject({ reason: "storage_failed" });
	} finally {
		await store.close(context);
	}
});
