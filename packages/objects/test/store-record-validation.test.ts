import { expect, test } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import { applyBatch } from "../src/store/apply-batch.ts";
import { checkWrite, type ArchivePart } from "../src/store/archive.ts";
import { importStore, sqliteBackend } from "../src/store/index.ts";
import { ObjectsStore } from "../src/store/store.ts";
import { openNodeSqliteDatabase } from "../src/sqlite/node.ts";

const table = {
	kind: "table",
	table: "team:notes",
	version: 1,
	state: "ready",
	fingerprint: "notes-v1",
	columns: {
		id: { type: "str" },
		n: { type: "int" },
		note: { type: "str", optional: true },
		meta: { type: "json", optional: true, version: 1, fingerprint: "meta-v1" },
	},
	key: ["id"],
} as const;
const row = {
	kind: "put",
	table: table.table,
	version: 1,
	row: { id: "a", n: 1, meta: { text: "original" } },
	columns: { meta: 1 },
} as const;
const manifest = { kind: "manifest", format: 1, schema: 2, lastSeq: 1, nextId: 2 } as const;
async function snapshot(store: ObjectsStore): Promise<ArchivePart[]> {
	const parts: ArchivePart[] = [];
	for await (const part of store.export(context)) parts.push(part);
	return parts;
}

test("archive imports reject invalid table names, column metadata and keys", async () => {
	const cases: [string, unknown][] = [
		["unqualified table", { ...table, table: "notes" }],
		["invalid table owner", { ...table, table: ":notes" }],
		["invalid column name", { ...table, columns: { id: { type: "str" }, "bad-name": { type: "str" } } }],
		["case-colliding columns", { ...table, columns: { id: { type: "str" }, ID: { type: "str" } } }],
		["empty key", { ...table, key: [] }],
		["repeated key", { ...table, key: ["id", "id"] }],
		["unknown key column", { ...table, key: ["absent"] }],
		["optional key", { ...table, key: ["note"] }],
		["JSON key", { ...table, key: ["meta"] }],
		[
			"JSON without version",
			{ ...table, columns: { id: { type: "str" }, meta: { type: "json", fingerprint: "meta" } } },
		],
		["JSON without fingerprint", { ...table, columns: { id: { type: "str" }, meta: { type: "json", version: 1 } } }],
		["scalar with JSON metadata", { ...table, columns: { id: { type: "str", version: 1, fingerprint: "id" } } }],
		[
			"optional scalar default",
			{ ...table, columns: { id: { type: "str" }, note: { type: "str", optional: true, default: "value" } } },
		],
		[
			"JSON default",
			{
				...table,
				columns: { id: { type: "str" }, meta: { type: "json", version: 1, fingerprint: "meta", default: "value" } },
			},
		],
		["wrong scalar default", { ...table, columns: { id: { type: "str" }, n: { type: "int", default: "value" } } }],
	];
	for (const [label, invalid] of cases) {
		const backend = sqliteBackend(await openNodeSqliteDatabase(":memory:"));
		await expect(
			importStore(backend, [manifest, invalid, { kind: "end", writes: 1 }], context),
			label,
		).rejects.toMatchObject({ code: "invalid" });
	}
});

test("imported rows need matching table and JSON versions and cannot introduce unknown columns", async () => {
	const cases: [string, unknown][] = [
		["unknown table", { ...row, table: "team:missing" }],
		["unknown row column", { ...row, row: { ...row.row, extra: "value" } }],
		["missing required column", { ...row, row: { id: "a" } }],
		["wrong scalar", { ...row, row: { ...row.row, n: "value" } }],
		["newer row version", { ...row, version: 2 }],
		["missing JSON version", { ...row, columns: {} }],
		["newer JSON version", { ...row, columns: { meta: 2 } }],
		["version for scalar", { ...row, columns: { meta: 1, n: 1 } }],
		["version for absent cell", { ...row, row: { id: "a", n: 1 } }],
	];
	for (const [label, invalid] of cases) {
		const backend = sqliteBackend(await openNodeSqliteDatabase(":memory:"));
		await expect(
			importStore(backend, [manifest, table, invalid, { kind: "end", writes: 2 }], context),
			label,
		).rejects.toMatchObject({ code: "invalid" });
	}
});

test("replay rejects malformed edits, indexes, expressions and conditions atomically, then accepts a valid write", async () => {
	const opened = await importStore(
		sqliteBackend(await openNodeSqliteDatabase(":memory:")),
		[
			manifest,
			table,
			row,
			{ kind: "index", table: table.table, name: "by_n", columns: ["n"] },
			{ kind: "end", writes: 3 },
		],
		context,
	);
	if (!(opened instanceof ObjectsStore)) throw new Error("Expected SQLite-backed Store");
	const update = { kind: "update", table: table.table, key: { id: "a" }, set: { n: 2 }, columns: {}, count: 1 };
	const alter = { kind: "alter", table: table.table, version: 2 };
	const where = { kind: "updateWhere", table: table.table, set: { n: 2 }, columns: {}, count: 1 };
	const cases: [string, unknown][] = [
		["empty key", { ...update, key: {} }],
		["wrong key column", { ...update, key: { unknown: "a" } }],
		["empty set", { ...update, set: {} }],
		["null set", { ...update, set: null }],
		["primary key edit", { ...update, set: { id: "b" } }],
		["unknown set column", { ...update, set: { absent: 2 } }],
		["bad expression", { ...update, set: { n: { invalid: [] } } }],
		["unknown column reference", { ...update, set: { n: { col: "absent" } } }],
		["wrong expression arity", { ...update, set: { n: { add: [1] } } }],
		["invalid prefix replacement", { ...update, set: { note: { replacePrefix: ["text", 2, "other"] } } }],
		["newer JSON cell", { ...update, set: { meta: { json: { text: "new" } } }, columns: { meta: 2 } }],
		["non-condition", { ...where, where: null }],
		["unknown predicate", { ...where, where: { invalid: ["n", 1] } }],
		["unknown predicate column", { ...where, where: { eq: ["absent", 1] } }],
		["JSON predicate", { ...where, where: { eq: ["meta", 1] } }],
		["invalid membership", { ...where, where: { inArray: ["n", 1] } }],
		["non-string prefix", { ...where, where: { prefix: ["note", 1] } }],
		["non-scalar operand", { ...where, where: { eq: ["n", {}] } }],
		["invalid boolean clause", { ...where, where: { and: [null] } }],
		["rename missing column", { ...alter, edit: { kind: "rename", from: "missing", to: "body" } }],
		["rename to occupied name", { ...alter, edit: { kind: "rename", from: "n", to: "ID" } }],
		["drop primary key", { ...alter, edit: { kind: "drop", name: "id" } }],
		["drop indexed column", { ...alter, edit: { kind: "drop", name: "n" } }],
		[
			"add required column without default",
			{ ...alter, edit: { kind: "add", name: "required", column: { type: "str" } } },
		],
		[
			"retype scalar as JSON",
			{ ...alter, edit: { kind: "json", name: "n", column: { type: "json", version: 1, fingerprint: "meta" } } },
		],
		["skip schema version", { ...alter, version: 3, edit: { kind: "drop", name: "note" } }],
		["drop missing index", { kind: "dropIndex", table: table.table, name: "missing" }],
		["duplicate index", { kind: "index", table: table.table, name: "by_n", columns: ["n"] }],
		["invalid index name", { kind: "index", table: table.table, name: "bad-name", columns: ["n"] }],
	];
	try {
		const before = await snapshot(opened);
		for (const [label, raw] of cases) {
			const write = checkWrite(raw, label, context);
			await expect(applyBatch(opened, [{ seq: 2, nextId: 2, writes: [write] }], context), label).rejects.toMatchObject({
				code: "invalid",
			});
			expect(opened.lastSeq, label).toBe(1);
			expect(await snapshot(opened), label).toEqual(before);
		}
		const write = checkWrite(
			{ ...where, count: 0, where: { and: [{ gte: ["n", 1] }, { not: { isNull: "note" } }] } },
			"valid condition",
			context,
		);
		await applyBatch(opened, [{ seq: 2, nextId: 2, writes: [write] }], context);
		expect(opened.lastSeq).toBe(2);
		const next = checkWrite(
			{
				...where,
				where: { or: [{ eq: ["id", "a"] }, { lt: ["n", 0] }] },
				set: {
					n: { add: [{ col: "n" }, 1] },
					note: { when: [{ gt: ["n", 0] }, "positive", "other"] },
					meta: { json: { text: "updated" } },
				},
				columns: { meta: 1 },
			},
			"valid expressions",
			context,
		);
		await applyBatch(opened, [{ seq: 3, nextId: 2, writes: [next] }], context);
		expect((await snapshot(opened)).filter((part) => part.kind === "put")).toEqual([
			expect.objectContaining({ row: { id: "a", n: 2, note: "positive", meta: { text: "updated" } } }),
		]);
	} finally {
		await opened.close(context);
	}
});
