import { expect, it } from "vitest";
import { IdAllocator } from "../src/store/allocator.ts";
import {
	readCatalog,
	writeCatalog,
	type TableRecord,
} from "../src/store/catalog.ts";
import {
	changeDocument,
	createDocument,
	findDocument,
	insertDocument,
	loadContent,
	readDocument,
	retireDocument,
	retireRecord,
	writeContent,
	listDocumentKeys,
	listDocumentEntries,
} from "../src/store/engine.ts";
import { applyStoreSchema } from "../src/store/schema.ts";
import { Step, type StagedWrite } from "../src/store/step.ts";
import { openNodeSqliteDatabase } from "../src/sqlite/node.ts";
import type { StoreWrite } from "../src/store/writes.ts";

async function fixture() {
	const db = await openNodeSqliteDatabase(":memory:");
	await applyStoreSchema(db);
	const ids = new IdAllocator(2),
		catalog = new Map<string, TableRecord>();
	let seq = 0;
	const commit = async (writes: readonly StagedWrite[]): Promise<Step> => {
		const step = await db.transaction(async (executor) => {
			const step = new Step(executor, seq + 1, ids, catalog);
			for (const write of writes) await write.apply(step);
			await writeCatalog(step);
			return step;
		});
		seq++;
		for (const [name, record] of step.tables) catalog.set(name, record);
		return step;
	};
	return { db, ids, commit, catalog };
}
const address = { owner: "app", namespace: "notes", kind: "note", key: "" };
it("applies deltas atomically, refuses stale revisions, and frees a retired live address", async () => {
	const { db, commit } = await fixture();
	try {
		const made = await commit([
			createDocument(
				address,
				{ version: 1, fingerprint: "one", value: { n: 0 } },
				'{"n":0}',
			),
		]);
		const id = made.created[0]!;
		await commit([
			changeDocument(
				id,
				1,
				{ kind: "delta", version: 1, ops: [["s", ["n"], 7]] },
				'[["s",["n"],7]]',
			),
		]);
		expect(await loadContent(db, id, "current")).toEqual({
			value: { n: 7 },
			version: 1,
			deltasSinceBase: 1,
		});
		await expect(
			commit([
				changeDocument(id, 1, { kind: "delta", version: 1, ops: [] }, "[]"),
			]),
		).rejects.toThrow("not live at revision 1");
		expect((await readDocument(db, id))?.revision).toBe(2);
		expect(await listDocumentKeys(db, address, undefined, 10)).toEqual([""]);
		await commit([
			retireDocument(id, 2),
			createDocument(
				address,
				{ version: 2, fingerprint: "two", value: { ready: true } },
				'{"ready":true}',
			),
		]);
		expect(await readDocument(db, id)).toBeUndefined();
		expect((await findDocument(db, address))?.version).toBe(2);
	} finally {
		await db.close();
	}
});
it("keeps rewindable content at each point and excludes the retirement boundary", async () => {
	const { db, commit } = await fixture();
	const stage = (apply: (step: Step) => Promise<void>): StagedWrite => ({
		order: "write",
		async apply(step): Promise<StoreWrite[]> {
			await apply(step);
			return [];
		},
	});
	try {
		await commit([
			stage((step) =>
				insertDocument(
					step,
					{
						...address,
						id: 10,
						history: "rewindable",
						createdAt: step.seq,
						revision: 1,
						version: 1,
						fingerprint: "one",
						meta: "{}",
					},
					'{"n":1}',
				),
			),
		]);
		await commit([
			stage((step) =>
				writeContent(
					step,
					10,
					"rewindable",
					1,
					{ kind: "base", version: 1, fingerprint: "one", value: { n: 2 } },
					'{"n":2}',
				),
			),
		]);
		await commit([
			stage(async (step) =>
				retireRecord(step, (await readDocument(step, 10))!),
			),
		]);
		expect((await findDocument(db, address, 2))?.id).toBe(10);
		expect(await findDocument(db, address, 3)).toBeUndefined();
		expect((await loadContent(db, 10, 1)).value).toEqual({ n: 1 });
		expect((await loadContent(db, 10, 2)).value).toEqual({ n: 2 });
		expect(await listDocumentEntries(db, address, "current", 0, 10)).toEqual(
			[],
		);
		expect(await readCatalog(db)).toEqual(new Map());
	} finally {
		await db.close();
	}
});
