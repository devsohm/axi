import { expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "../src/context/index.ts";
import { arr, int, local, method, obj, opt, str } from "../src/contracts/index.ts";
import { createHost, defineFacet, type HostError } from "../src/host/index.ts";
import { json, openStore, sqliteBackend } from "../src/store/index.ts";
import type { WatchCall } from "../src/watch.ts";
import { applySet, matches } from "../src/store/evaluate.ts";
import { ColumnRef, add, coalesce, compileSet, prefix } from "../src/store/expression.ts";
import { decodeCursor, encodeCursor, query } from "../src/store/query.ts";
import { createTableSql, TableSql } from "../src/store/sql.ts";
import { defineTable } from "../src/store/table.ts";
import { openNodeSqliteDatabase } from "../src/sqlite/node.ts";
import type { SqliteValue } from "../src/sqlite/index.ts";

it("binds user text, updates nullable counters, and agrees with the SQL evaluator", async () => {
	const table = defineTable("items", {
		version: 1,
		columns: { id: str(), text: str(), count: opt(int()) },
		key: ["id"],
	});
	const rows = [
		{ id: "a", text: "note/'😀", count: 3 },
		{ id: "b", text: "other" },
	];
	const db = await openNodeSqliteDatabase(":memory:");
	try {
		await db.run(createTableSql("items", table.record, table.key));
		const sql = new TableSql("items", table.columns, table.rows.physical, table.key);
		for (const row of rows) await db.run(sql.put, ...table.rows.put(row, 1).params);
		const selected = query(table).where((row) => prefix(row.text, "note/"));
		const read = sql.select(selected.condition, selected.order, undefined, 20);
		expect(read.params).toEqual(["note/", "note0", 20]);
		expect(await db.all(read.sql, ...read.params)).toEqual([{ id: "a", text: "note/'😀", count: 3 }]);
		expect(rows.filter((row) => matches(selected.condition!, row)).map((row) => row.id)).toEqual(["a"]);
		const set = compileSet(table, { count: add(coalesce(new ColumnRef<number, "int">("count"), 0), 2) }, "update");
		const update = sql.updateWhere({ and: [] }, set, new Map());
		await db.run(update.sql, ...update.params);
		const values = await db.all<Record<string, SqliteValue>>("SELECT * FROM items ORDER BY id");
		expect(values.map((row) => table.rows.decode(row, BACKGROUND_CONTEXT))).toEqual(
			rows.map((row) => applySet(set, row, "items")),
		);
	} finally {
		await db.close();
	}
});
it("keeps queries immutable and binds page cursors to their table and ordering", () => {
	const table = defineTable("entries", {
		version: 1,
		columns: { id: str(), time: int() },
		key: ["id"],
	});
	const base = query(table),
		sorted = base.orderBy((row) => row.time, "desc");
	expect(base.order).toEqual({ columns: ["id"], direction: "asc" });
	expect(sorted.order).toEqual({ columns: ["time", "id"], direction: "desc" });
	const cursor = encodeCursor("owner:entries", sorted.order, [4, "a"]);
	expect(decodeCursor(table, "owner:entries", sorted.order, cursor)).toEqual([4, "a"]);
	expect(() => decodeCursor(table, "other:entries", sorted.order, cursor)).toThrow("not one of this table's order");
});

it("keeps live-query failures local, retains the last rows and publishes recovery", async () => {
	const database = await openNodeSqliteDatabase(":memory:");
	const store = await openStore(sqliteBackend(database), BACKGROUND_CONTEXT);
	const errors: HostError[] = [];
	const host = createHost({ store, onError: (error) => errors.push(error) });
	const row = obj({ id: str(), data: obj({ count: int() }) });
	const board = local("query.recovery", {
		version: 1,
		params: {},
		members: { rows: arr(row), put: method(row) },
	});
	const table = defineTable("entries", {
		version: 1,
		columns: { id: str(), data: json(obj({ count: int() }), { version: 1 }) },
		key: ["id"],
	});
	try {
		await host.load(
			[
				{
					name: "queries",
					facet: defineFacet((facet) =>
						facet.serve(board, (_, self) => {
							const handle = self.table(table);
							return {
								rows: self.query(handle, query(table), 10),
								put: async (value, context) => {
									await self.tx((tx) => tx.put(handle, value), context);
									return null;
								},
							};
						}),
					),
				},
			],
			BACKGROUND_CONTEXT,
		);
		const reference = await host.get(board, {}, BACKGROUND_CONTEXT);
		await reference.put({ id: "first", data: { count: 1 } }, BACKGROUND_CONTEXT);
		const last = reference.rows.value;
		const watch = await reference.rows.watch(BACKGROUND_CONTEXT);
		const calls: WatchCall<unknown>[] = [];
		watch.start(async (call) => {
			calls.push(call);
		});
		try {
			await database.run('UPDATE "query.recovery:entries" SET "data$v" = 9 WHERE id = ?', "first");
			await reference.put({ id: "second", data: { count: 2 } }, BACKGROUND_CONTEXT);
			await reference.put({ id: "third", data: { count: 3 } }, BACKGROUND_CONTEXT);
			expect(() => reference.rows.value).toThrow("stored at version 9");
			expect(reference.state.value).toEqual({ kind: "live" });
			expect(errors.map((error) => error.kind)).toEqual(["query_failed"]);
			await vi.waitFor(() => expect(calls.map((call) => call.kind)).toEqual(["failed"]));
			const late = await reference.rows.watch(BACKGROUND_CONTEXT);
			try {
				expect(late.value).toEqual(last);
				await reference.put({ id: "first", data: { count: 4 } }, BACKGROUND_CONTEXT);
				await vi.waitFor(() => expect(calls.map((call) => call.kind)).toEqual(["failed", "value"]));
				const recovered = reference.rows.value;
				expect(recovered.map((item) => item.data.count)).toEqual([4, 2, 3]);
				expect(calls[1]).toMatchObject({ kind: "value", ops: [["r", recovered]] });
				await database.run('UPDATE "query.recovery:entries" SET "data$v" = 9 WHERE id = ?', "first");
				await reference.put({ id: "fourth", data: { count: 5 } }, BACKGROUND_CONTEXT);
				expect(errors.map((error) => error.kind)).toEqual(["query_failed", "query_failed"]);
			} finally {
				await late.stop();
			}
		} finally {
			await watch.stop();
			reference.release();
		}
	} finally {
		await host.close(BACKGROUND_CONTEXT);
		await store.close(BACKGROUND_CONTEXT);
	}
});
