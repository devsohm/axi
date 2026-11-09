import { afterAll, beforeAll, expect, test } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import { bool, int, opt, str } from "../src/contracts/index.ts";
import { applySet, matches } from "../src/store/evaluate.ts";
import {
	add,
	and,
	coalesce,
	ColumnRef,
	compileSet,
	concat,
	eq,
	gt,
	gte,
	inArray,
	isNull,
	lt,
	lte,
	max,
	min,
	ne,
	not,
	or,
	prefix,
	replacePrefix,
	sub,
	when,
	type Condition,
} from "../src/store/expression.ts";
import { query } from "../src/store/query.ts";
import { createTableSql, TableSql } from "../src/store/sql.ts";
import { defineTable } from "../src/store/table.ts";
import { openNodeSqliteDatabase } from "../src/sqlite/node.ts";
import type { SqliteValue } from "../src/sqlite/database.ts";

const table = defineTable("expression_rows", {
	version: 1,
	columns: { id: str(), n: opt(int()), m: opt(int()), text: opt(str()), flag: bool() },
	key: ["id"],
});
const ref = {
	n: new ColumnRef<number, "int">("n"),
	m: new ColumnRef<number, "int">("m"),
	text: new ColumnRef<string, "str">("text"),
	flag: new ColumnRef<boolean, "bool">("flag"),
};
const rows = [
	{ id: "a", n: 0, m: 2, text: "abc", flag: false },
	{ id: "b", n: 3, m: -1, text: "ab'", flag: true },
	{ id: "c", n: -2, m: 5, text: "界", flag: true },
	{ id: "d", flag: false },
];
const sql = new TableSql("expression_rows", table.columns, table.rows.physical, table.key);
let database: Awaited<ReturnType<typeof openNodeSqliteDatabase>>;
beforeAll(async () => {
	database = await openNodeSqliteDatabase(":memory:");
	await database.run(createTableSql("expression_rows", table.record, table.key));
	for (const row of rows) await database.run(sql.put, ...table.rows.put(row, 1).params);
});
afterAll(async () => {
	await database.close();
});

const conditions: Array<{ name: string; condition: Condition; ids: string[] }> = [
	{ name: "equal", condition: eq(ref.n, 0), ids: ["a"] },
	{ name: "not equal", condition: ne(ref.n, 0), ids: ["b", "c"] },
	{ name: "less", condition: lt(ref.n, 0), ids: ["c"] },
	{ name: "less or equal", condition: lte(ref.n, 0), ids: ["a", "c"] },
	{ name: "greater", condition: gt(ref.n, 0), ids: ["b"] },
	{ name: "greater or equal", condition: gte(ref.n, 0), ids: ["a", "b"] },
	{ name: "absent value", condition: isNull(ref.n), ids: ["d"] },
	{ name: "present value", condition: not(isNull(ref.n)), ids: ["a", "b", "c"] },
	{ name: "membership", condition: inArray(ref.n, [-2, 3]), ids: ["b", "c"] },
	{ name: "empty membership", condition: inArray(ref.n, []), ids: [] },
	{ name: "negated membership", condition: not(inArray(ref.n, [-2, 3])), ids: ["a"] },
	{ name: "text prefix", condition: prefix(ref.text, "ab"), ids: ["a", "b"] },
	{ name: "Unicode prefix", condition: prefix(ref.text, "界"), ids: ["c"] },
	{ name: "missing prefix", condition: prefix(ref.text, "none"), ids: [] },
	{ name: "empty conjunction", condition: and(), ids: ["a", "b", "c", "d"] },
	{ name: "empty disjunction", condition: or(), ids: [] },
	{ name: "conjunction", condition: and(gte(ref.n, 0), eq(ref.flag, true)), ids: ["b"] },
	{ name: "disjunction", condition: or(isNull(ref.n), gt(ref.n, 0)), ids: ["b", "d"] },
	{ name: "negated comparison", condition: not(gt(ref.n, 0)), ids: ["a", "c"] },
	{ name: "contradictory predicates", condition: and(gt(ref.n, 0), lt(ref.n, 0)), ids: [] },
	{ name: "nullable alternative", condition: or(gt(ref.n, 0), lt(ref.n, 0)), ids: ["b", "c"] },
	{ name: "unknown and false", condition: and(gt(ref.n, 0), eq(ref.flag, false)), ids: [] },
	{ name: "unknown or true", condition: or(gt(ref.n, 0), eq(ref.flag, false)), ids: ["a", "b", "d"] },
	{ name: "unknown or false", condition: or(gt(ref.n, 0), eq(ref.flag, true)), ids: ["b", "c"] },
	{ name: "boolean equality", condition: eq(ref.flag, true), ids: ["b", "c"] },
	{ name: "binary text order", condition: gt(ref.text, "abc"), ids: ["c"] },
];

test.each(conditions)("$name agrees with SQL three-valued logic", async ({ condition, ids }) => {
	const selected = query(table).where(() => condition);
	if (!selected.condition) throw new Error("Missing compiled predicate");
	const statement = sql.select(selected.condition, selected.order, undefined, 20);
	expect(rows.filter((row) => matches(selected.condition!, row)).map((row) => row.id)).toEqual(ids);
	expect((await database.all<{ id: string }>(statement.sql, ...statement.params)).map((row) => row.id)).toEqual(ids);
});

const updates = [
	{ name: "addition", set: { n: add(ref.n, ref.m) }, values: [{ n: 2 }, { n: 2 }, { n: 3 }, {}] },
	{ name: "subtraction", set: { n: sub(ref.n, ref.m) }, values: [{ n: -2 }, { n: 4 }, { n: -7 }, {}] },
	{ name: "maximum", set: { n: max(ref.n, ref.m) }, values: [{ n: 2 }, { n: 3 }, { n: 5 }, {}] },
	{ name: "minimum", set: { n: min(ref.n, ref.m) }, values: [{ n: 0 }, { n: -1 }, { n: -2 }, {}] },
	{
		name: "concatenation",
		set: { text: concat(ref.text, "!") },
		values: [{ text: "abc!" }, { text: "ab'!" }, { text: "界!" }, {}],
	},
	{
		name: "prefix replacement",
		set: { text: replacePrefix(ref.text, "ab", "X") },
		values: [{ text: "Xc" }, { text: "X'" }, { text: "界" }, {}],
	},
	{ name: "fallback", set: { n: coalesce(ref.n, 7) }, values: [{ n: 0 }, { n: 3 }, { n: -2 }, { n: 7 }] },
	{
		name: "known condition",
		set: { text: when(eq(ref.flag, true), "accepted", "rejected") },
		values: [{ text: "rejected" }, { text: "accepted" }, { text: "accepted" }, { text: "rejected" }],
	},
	{
		name: "nullable condition",
		set: { text: when(gt(ref.n, 0), "positive", "nonpositive") },
		values: [{ text: "nonpositive" }, { text: "positive" }, { text: "nonpositive" }, { text: "nonpositive" }],
	},
	{ name: "clear optional value", set: { n: undefined }, values: [{}, {}, {}, {}] },
	{
		name: "simultaneous assignment",
		set: { n: add(coalesce(ref.n, 0), 1), m: ref.n },
		values: [{ n: 1, m: 0 }, { n: 4, m: 3 }, { n: -1, m: -2 }, { n: 1 }],
	},
];

test.each(updates)("$name reads the original row and agrees with persisted SQL updates", async ({ set, values }) => {
	const compiled = compileSet(table, set, "update");
	const keys = Object.keys(set);
	const expected = rows.map((row, index) => ({
		...Object.fromEntries(Object.entries(row).filter(([key]) => !keys.includes(key))),
		...values[index],
	}));
	expect(rows.map((row) => applySet(compiled, row, "expression_rows"))).toEqual(expected);
	await database.transaction(async (tx) => {
		const statement = sql.updateWhere({ and: [] }, compiled, new Map());
		await tx.run(statement.sql, ...statement.params);
		const actual = await tx.all<Record<string, SqliteValue>>("SELECT * FROM expression_rows ORDER BY id");
		expect(actual.map((row) => table.rows.decode(row, context))).toEqual(expected);
		for (const row of rows) await tx.run(sql.put, ...table.rows.put(row, 1).params);
	});
});

test.each(["add", "sub"] as const)("%s rejects unsafe integer results before changing the input row", (operation) => {
	const row = { id: "limit", n: Number.MAX_SAFE_INTEGER, m: operation === "add" ? 1 : -1, flag: false };
	const before = structuredClone(row);
	const compiled = compileSet(table, { n: operation === "add" ? add(ref.n, ref.m) : sub(ref.n, ref.m) }, "update");
	expect(() => applySet(compiled, row, "expression_rows")).toThrow(
		expect.objectContaining({ code: "invalid", reason: "args" }),
	);
	expect(row).toEqual(before);
});
