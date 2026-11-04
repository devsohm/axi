import { expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../src/context/index.ts";
import { int, opt, str } from "../src/next/contracts/index.ts";
import { applySet, matches } from "../src/next/store/evaluate.ts";
import {
	ColumnRef,
	add,
	coalesce,
	compileSet,
	prefix,
} from "../src/next/store/expression.ts";
import { decodeCursor, encodeCursor, query } from "../src/next/store/query.ts";
import { createTableSql, TableSql } from "../src/next/store/sql.ts";
import { defineTable } from "../src/next/store/table.ts";
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
		const sql = new TableSql(
			"items",
			table.columns,
			table.rows.physical,
			table.key,
		);
		for (const row of rows)
			await db.run(sql.put, ...table.rows.put(row, 1).params);
		const selected = query(table).where((row) => prefix(row.text, "note/"));
		const read = sql.select(selected.condition, selected.order, undefined, 20);
		expect(read.params).toEqual(["note/", "note0", 20]);
		expect(await db.all(read.sql, ...read.params)).toEqual([
			{ id: "a", text: "note/'😀", count: 3 },
		]);
		expect(
			rows
				.filter((row) => matches(selected.condition!, row))
				.map((row) => row.id),
		).toEqual(["a"]);
		const set = compileSet(
			table,
			{ count: add(coalesce(new ColumnRef<number, "int">("count"), 0), 2) },
			"update",
		);
		const update = sql.updateWhere({ and: [] }, set, new Map());
		await db.run(update.sql, ...update.params);
		const values = await db.all<Record<string, SqliteValue>>(
			"SELECT * FROM items ORDER BY id",
		);
		expect(
			values.map((row) => table.rows.decode(row, BACKGROUND_CONTEXT)),
		).toEqual(rows.map((row) => applySet(set, row, "items")));
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
	expect(decodeCursor(table, "owner:entries", sorted.order, cursor)).toEqual([
		4,
		"a",
	]);
	expect(() =>
		decodeCursor(table, "other:entries", sorted.order, cursor),
	).toThrow("not one of this table's order");
});
