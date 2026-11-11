import { expect, test } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import { hostKind, opt, str } from "../src/contracts/index.ts";
import { openNodeSqliteDatabase } from "../src/sqlite/node.ts";
import { host, HostColumn } from "../src/store/host-column.ts";
import { columnRecord, describeColumns } from "../src/store/columns.ts";
import { Condition, compileSet, compileWhere, eq, inArray, ne } from "../src/store/expression.ts";
import { LiveQueries } from "../src/store/live-query.ts";
import { sqliteBackend } from "../src/store/backend.ts";
import { query } from "../src/store/query.ts";
import { openStore, type ObjectsStore } from "../src/store/store.ts";
import { TableChanges } from "../src/store/table-changes.ts";
import { TableHandle } from "../src/store/table-handle.ts";
import { defineTable } from "../src/store/table.ts";
import { evolveTable } from "../src/store/table-evolve.ts";
import { prepareTables } from "../src/store/table-migration.ts";
import type { StagedWrite } from "../src/store/step.ts";

const Worker = hostKind("worker", { id: str() });
const Worker2 = hostKind("worker2", { id: str() });
const definition = () =>
	defineTable("labels", { version: 1, columns: { id: str(), worker: host(Worker), label: str() }, key: ["id"] });
const fence = { admit: () => true, adopt() {} };

test("host columns canonicalize addresses at the text boundary", () => {
	const column = new HostColumn(Worker);
	expect(column.key({ ...Worker({ id: "one" }), key: "worker|wrong" }, "labels.worker")).toBe("worker|one");
	expect(column.key(Worker({ id: "broken\uD800" }), "labels.worker")).toBe("worker|broken\uFFFD");
	expect(column.address("worker|a\\|b")).toEqual(Worker({ id: "a|b" }));
	for (const value of [undefined, "worker|one", Worker2({ id: "one" })])
		expect(() => column.key(value, "labels.worker")).toThrow("expected an address of worker");
	expect(() => column.key(Worker({ id: "a\0b" }), "labels.worker")).toThrow("NUL");
	expect(() => new HostColumn({ kind: "worker" })).toThrow("not a declared host kind");
});

test("host tables record one host column and add an index when the primary key does not cover it", () => {
	const table = definition();
	expect(table.record.worker).toEqual({ type: "str", host: "worker" });
	expect(table.indexes.get("host")).toEqual(["worker"]);
	expect(table.hostColumn?.name).toBe("worker");
	const primary = defineTable("primary_hosts", {
		version: 1,
		columns: { worker: host(Worker), id: str() },
		key: ["worker", "id"],
	});
	expect(primary.indexes.has("host")).toBe(false);
	expect(() =>
		defineTable("many_hosts", {
			version: 1,
			columns: { id: str(), first: host(Worker), second: host(Worker2) },
			key: ["id"],
		}),
	).toThrow("more than one host");
	expect(() =>
		defineTable("bad_index", {
			version: 1,
			columns: { id: str(), worker: host(Worker) },
			key: ["id"],
			indexes: { host: ["id"] },
		}),
	).toThrow("column's own");
	expect(() => describeColumns({ worker: opt(host(Worker)) } as never, "bad_optional")).toThrow("not opt");
	expect(columnRecord(describeColumns({ worker: host(Worker) }, "hosts")[0]!)).toEqual({ type: "str", host: "worker" });
	const other = defineTable("labels", {
		version: 1,
		columns: { id: str(), worker: host(Worker2), label: str() },
		key: ["id"],
	});
	expect(table.fingerprint).not.toBe(other.fingerprint);
});

test("row encoding and host equality use stored keys while reads return typed addresses", () => {
	const table = definition(),
		address = Worker({ id: "one" });
	const encoded = table.rows.put({ id: "a", worker: address, label: "blue" }, 1);
	expect(encoded.row.worker).toBe(address.key);
	const read = table.rows.decode({ id: "a", worker: address.key, label: "blue", $v: 1 }, context);
	expect(read.worker).toEqual(address);
	expect(table.rows.addressed(table.rows.stored(read))).toEqual(read);
	expect(query(table).where((columns) => eq(columns.worker, address)).condition).toEqual({
		eq: ["worker", address.key],
	});
	expect(query(table).where((columns) => ne(columns.worker, address)).condition).toEqual({
		ne: ["worker", address.key],
	});
	expect(query(table).where((columns) => inArray(columns.worker, [address])).condition).toEqual({
		inArray: ["worker", [address.key]],
	});
	expect(compileSet(table, { worker: address }, "set")).toEqual({ worker: address.key });
	for (const op of ["lt", "lte", "gt", "gte", "isNull", "prefix"] as const)
		expect(() => compileWhere(table, new Condition(op, [table.refs.worker, address]), "where")).toThrow(
			"eq, ne, inArray only",
		);
	expect(() => compileSet(table, { label: table.refs.worker }, "set")).toThrow("holds addresses");
	expect(() => compileSet(table, { worker: table.refs.label }, "set")).toThrow("host(...) columns take plain values");
});

test("host-address primary keys and table evolution preserve the host index rules", () => {
	const table = defineTable("keys", {
		version: 1,
		columns: { worker: host(Worker), id: str(), label: str() },
		key: ["worker", "id"],
	});
	expect(table.rows.key({ worker: Worker({ id: "owner" }), id: "entry" }, "get").params).toEqual([
		"worker|owner",
		"entry",
	]);
	const changed = evolveTable(definition(), (editor) => editor.rename("worker", "owner"));
	expect(changed.hostColumn?.name).toBe("owner");
	expect(changed.indexes.get("host")).toEqual(["owner"]);
	const dropped = evolveTable(definition(), (editor) => editor.drop("worker"));
	expect(dropped.hostColumn).toBeUndefined();
	expect(dropped.indexes.has("host")).toBe(false);
});

test("stored rows, transaction overlays, queries, and archives retain host addresses", async () => {
	const store = (await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context)) as ObjectsStore;
	const table = definition(),
		name = "app:labels",
		first = Worker({ id: "first" }),
		second = Worker({ id: "second" });
	const owner = {
		label: "app",
		scope: {},
		queries: new LiveQueries(),
		assertLive() {},
		fail(error: Error) {
			throw error;
		},
	};
	try {
		await prepareTables([{ definition: table, table: name }], store, fence, "app", context);
		const handle = new TableHandle(table, name, store, owner);
		let writes: StagedWrite[] = [],
			changes = new TableChanges(handle, writes);
		changes.put({ id: "a", worker: first, label: "blue" });
		await store.commit(writes, fence, context);
		expect(await handle.get({ id: "a" }, context)).toEqual({ id: "a", worker: first, label: "blue" });
		writes = [];
		changes = new TableChanges(handle, writes);
		changes.update({ id: "a" }, { worker: second });
		expect(await changes.get({ id: "a" }, context)).toEqual({ id: "a", worker: second, label: "blue" });
		await store.commit(writes, fence, context);
		expect(
			(
				await handle.page(
					query(table).where((columns) => eq(columns.worker, second)),
					10,
					context,
				)
			).items,
		).toEqual([{ id: "a", worker: second, label: "blue" }]);
		const archive = [];
		for await (const part of store.export(context)) archive.push(part);
		expect(archive.find((part) => part.kind === "table")).toMatchObject({
			columns: { worker: { type: "str", host: "worker" } },
		});
	} finally {
		await store.close(context);
	}
});
