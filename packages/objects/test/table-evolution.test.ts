import { expect, test } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import { int, obj, opt, str } from "../src/contracts/index.ts";
import { openNodeSqliteDatabase } from "../src/sqlite/node.ts";
import {
	add,
	eq,
	evolveTable,
	defineTable,
	json,
	openStore,
	sqliteBackend,
	type TableEditor,
} from "../src/store/index.ts";
import { LiveQueries } from "../src/store/live-query.ts";
import { ObjectsStore } from "../src/store/store.ts";
import { TableChanges } from "../src/store/table-changes.ts";
import { TableHandle } from "../src/store/table-handle.ts";
import { prepareTables } from "../src/store/table-migration.ts";
import type { StagedWrite } from "../src/store/step.ts";

const columns = { id: str(), n: int(), obsolete: str(), extra: opt(json(obj({ label: str() }), { version: 1 })) };
const first = defineTable("items", { version: 1, columns, key: ["id"], indexes: { by_obsolete: ["obsolete"] } });
const fence = { admit: () => true, adopt() {} };
const owner = {
	label: "app",
	scope: {},
	queries: new LiveQueries(),
	assertLive() {},
	fail(error: Error): never {
		throw error;
	},
};

test("table evolution migrates real rows through renamed keys, JSON versions, bulk updates and dropped indexes", async () => {
	const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context);
	if (!(store instanceof ObjectsStore)) throw new Error("Expected the SQLite store implementation");
	try {
		await prepareTables([{ table: "app:items", definition: first }], store, fence, "app", context);
		const handle = new TableHandle(first, "app:items", store, owner),
			writes: StagedWrite[] = [];
		const changes = new TableChanges(handle, writes);
		changes.put({ id: "a", n: 1, obsolete: "old", extra: { label: "value" } });
		changes.put({ id: "b", n: 2, obsolete: "unused" });
		await store.commit(writes, fence, context);
		const second = evolveTable(first, (table) =>
			table
				.rename("id", "key")
				.add("flag", opt(str()))
				.json(
					"extra",
					json(obj({ label: str(), count: int() }), {
						version: 2,
						migrate(value) {
							if (!value || typeof value !== "object" || !("label" in value) || typeof value.label !== "string")
								throw new Error("Invalid old row");
							return { label: value.label, count: 1 };
						},
					}),
				)
				.update({ where: (row) => eq(row.n, 1), set: (row) => ({ n: add(row.n, 10) }) })
				.drop("obsolete")
				.index("by_n", ["n"]),
		);
		await prepareTables([{ table: "app:items", definition: second }], store, fence, "app", context);
		const current = new TableHandle(second, "app:items", store, owner);
		expect(await current.get({ key: "a" }, context)).toEqual({ key: "a", n: 11, extra: { label: "value", count: 1 } });
		expect(await current.get({ key: "b" }, context)).toEqual({ key: "b", n: 2 });
		expect([...second.indexes.keys()]).toEqual(["by_n"]);
		const third = evolveTable(second, (table) => table.update({ set: { flag: "all" } }));
		await prepareTables([{ table: "app:items", definition: third }], store, fence, "app", context);
		const fourth = evolveTable(third, (table) => table.rows((row) => ({ n: row.n * 2 })).dropIndex("by_n"));
		await prepareTables([{ table: "app:items", definition: fourth }], store, fence, "app", context);
		const final = new TableHandle(fourth, "app:items", store, owner);
		expect(await final.get({ key: "a" }, context)).toEqual({
			key: "a",
			n: 22,
			flag: "all",
			extra: { label: "value", count: 1 },
		});
		expect(await final.get({ key: "b" }, context)).toEqual({ key: "b", n: 4, flag: "all" });
		expect(fourth.indexes.size).toBe(0);
		await expect(handle.get({ id: "a" }, context)).rejects.toMatchObject({ code: "released", reason: "version" });
	} finally {
		await store.close(context);
	}
});

test("invalid JavaScript schema edits fail before altering the original table definition", () => {
	type Editor = TableEditor<typeof columns, readonly ["id"]>;
	for (const [edit, message] of [
		[(table: Editor) => Reflect.apply(table.rename, table, ["missing", "x"]), /no column/],
		[(table: Editor) => table.rename("n", "ID"), /collide/],
		[(table: Editor) => Reflect.apply(table.add, table, ["required", str()]), /needs opt/],
		[(table: Editor) => table.add("N", str({ default: "" })), /collide/],
		[(table: Editor) => Reflect.apply(table.json, table, ["n", json(str(), { version: 1 })]), /not a json/],
		[
			(table: Editor) => Reflect.apply(table.json, table, ["extra", opt(json(str(), { version: 1 }))]),
			/keeps its nullability/,
		],
		[(table: Editor) => table.json("extra", str()), /expected a json/],
		[(table: Editor) => table.json("extra", json(str(), { version: 1 })), /raise its version/],
		[(table: Editor) => Reflect.apply(table.drop, table, ["id"]), /key column/],
		[(table: Editor) => table.index("INVALID", ["n"]), /expected/],
		[(table: Editor) => table.index("by_obsolete", ["n"]), /exists/],
		[(table: Editor) => table.dropIndex("absent"), /no index/],
		[
			(table: Editor) => {
				table.dropIndex("by_obsolete");
				table.rename("n", "value");
			},
			/comes before/,
		],
		[(table: Editor) => Reflect.apply(table.rows, table, [null]), /expected a function/],
	] satisfies [(table: Editor) => unknown, RegExp][]) {
		expect(() =>
			evolveTable(first, (table) => {
				edit(table);
				return table;
			}),
		).toThrow(message);
		expect(first.version).toBe(1);
		expect(Object.keys(first.schemas)).toEqual(["id", "n", "obsolete", "extra"]);
		expect(first.indexes.has("by_obsolete")).toBe(true);
	}
	const versioned = defineTable("versioned", {
		version: 1,
		columns: { id: str(), value: json(str(), { version: 2 }) },
		key: ["id"],
	});
	expect(() => evolveTable(versioned, (table) => table.json("value", json(str(), { version: 1 })))).toThrow(
		/goes back/,
	);
});
