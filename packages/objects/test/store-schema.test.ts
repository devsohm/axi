import { describe, expect, it } from "vitest";
import { openNodeSqliteDatabase } from "../src/sqlite/node.ts";
import {
	readCatalog,
	writeCatalog,
	type TableRecord,
} from "../src/next/store/catalog.ts";
import {
	applyStoreSchema,
	STORE_SCHEMA,
	TABLES,
} from "../src/next/store/schema.ts";

describe("store schema", () => {
	it("initializes metadata and roundtrips table definitions through a real SQLite transaction", async () => {
		const db = await openNodeSqliteDatabase(":memory:");
		try {
			expect(await applyStoreSchema(db)).toEqual({
				last_seq: 0,
				next_id: 2,
				outbox: 0,
				outbox_floor: 0,
			});
			expect(await db.get("SELECT version FROM objects_store_schema")).toEqual({
				version: STORE_SCHEMA,
			});
			const record: TableRecord = {
				table: "app:items",
				version: 1,
				state: "ready",
				columns: { id: { type: "str" } },
				key: ["id"],
				fingerprint: "00",
				indexes: {},
			};
			await db.transaction((tx) =>
				writeCatalog({
					run: tx.run.bind(tx),
					tables: new Map([[record.table, record]]),
				}),
			);
			expect([...(await readCatalog(db))]).toEqual([[record.table, record]]);
			await db.run(
				`UPDATE ${TABLES.meta} SET last_seq = ?, next_id = ?`,
				8,
				10,
			);
			expect(await applyStoreSchema(db)).toEqual({
				last_seq: 8,
				next_id: 10,
				outbox: 0,
				outbox_floor: 0,
			});
		} finally {
			await db.close();
		}
	});
	it("refuses a non-UTF8 database and a schema newer than its supported version", async () => {
		const utf16 = await openNodeSqliteDatabase(":memory:");
		try {
			await utf16.exec('PRAGMA encoding = "UTF-16le"');
			await expect(applyStoreSchema(utf16)).rejects.toThrow("not UTF-8");
		} finally {
			await utf16.close();
		}
		const newer = await openNodeSqliteDatabase(":memory:");
		try {
			await applyStoreSchema(newer);
			await newer.run(
				"UPDATE objects_store_schema SET version = ?",
				STORE_SCHEMA + 1,
			);
			await expect(applyStoreSchema(newer)).rejects.toThrow(
				"newer than supported",
			);
		} finally {
			await newer.close();
		}
	});
});
