import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import { int, obj, opt, str } from "../src/next/contracts/index.ts";
import { applyBatch } from "../src/next/store/apply-batch.ts";
import type { ArchivePart } from "../src/next/store/archive.ts";
import { sqliteBackend } from "../src/next/store/backend.ts";
import { createDocument } from "../src/next/store/engine.ts";
import { importStore } from "../src/next/store/import.ts";
import { json } from "../src/next/store/json-column.ts";
import { decodeJsonl, encodeJsonl } from "../src/next/store/jsonl.ts";
import { query } from "../src/next/store/query.ts";
import type { StagedWrite } from "../src/next/store/step.ts";
import { openStore, type ObjectsStore } from "../src/next/store/store.ts";
import { defineTable } from "../src/next/store/table.ts";
import { TableChanges } from "../src/next/store/table-changes.ts";
import { evolveTable } from "../src/next/store/table-evolve.ts";
import { TableHandle } from "../src/next/store/table-handle.ts";
import { prepareTables } from "../src/next/store/table-migration.ts";
import { openNodeSqliteDatabase } from "../src/sqlite/node.ts";

const fence = { admit: () => true, adopt: () => {} };
const definition = defineTable("notes", {
	version: 1,
	columns: {
		id: str(),
		n: int(),
		extra: opt(json(obj({ text: str() }), { version: 1 })),
	},
	key: ["id"],
	indexes: { by_n: ["n"] },
});
const owner = {
	label: "app",
	scope: {},
	assertLive() {},
	fail(error: Error): void {
		throw error;
	},
};
async function collect<Value>(input: AsyncIterable<Value>): Promise<Value[]> {
	const values: Value[] = [];
	for await (const value of input) values.push(value);
	return values;
}
async function* from<Value>(values: readonly Value[]): AsyncIterable<Value> {
	yield* values;
}
async function fresh(): Promise<ObjectsStore> {
	return (await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context, {
		outbox: true,
	})) as ObjectsStore;
}
it("exports through split UTF-8 JSONL, imports, and replays the outbox into the same stored state", async () => {
	const source = await fresh(),
		replica = await fresh();
	let imported: ObjectsStore | undefined;
	try {
		await prepareTables([{ table: "app:notes", definition }], source, fence, "app", context);
		const handle = new TableHandle(definition, "app:notes", source, owner),
			writes: StagedWrite[] = [],
			changes = new TableChanges(handle, writes);
		changes.put({ id: "a", n: 1, extra: { text: "café 😀" } });
		changes.put({ id: "b", n: 2 });
		changes.update({ id: "b" }, { n: 8 });
		changes.delete({ id: "absent" });
		writes.push(
			createDocument(
				{ owner: "app", namespace: "notes", kind: "note" },
				{ version: 1, fingerprint: "one", value: { ready: true } },
				'{"ready":true}',
			),
		);
		await source.commit(writes, fence, context);
		const next = evolveTable(definition, (table) =>
			table.add("tag", str({ default: "" })).rows((row) => ({ tag: row.id })),
		);
		await prepareTables([{ table: "app:notes", definition: next }], source, fence, "app", context);
		const archive = await collect(source.export(context)),
			encoded = await collect(encodeJsonl(from(archive)));
		const bytes = encoded.flatMap((chunk) => Array.from(chunk, (byte) => Uint8Array.of(byte)));
		imported = (await importStore(
			sqliteBackend(await openNodeSqliteDatabase(":memory:")),
			decodeJsonl(from(bytes)),
			context,
		)) as ObjectsStore;
		expect(await collect(imported.export(context))).toEqual(archive);
		await applyBatch(replica, await source.outbox!.read(0, 100, context), context);
		expect(await collect(replica.export(context))).toEqual(archive);
		expect((await new TableHandle(next, "app:notes", imported, owner).page(query(next), 10, context)).items).toEqual([
			{ id: "a", n: 1, extra: { text: "café 😀" }, tag: "a" },
			{ id: "b", n: 8, tag: "b" },
		]);
	} finally {
		await source.close(context);
		await replica.close(context);
		await imported?.close(context);
	}
});
it("rolls back a malformed archive, including schema creation", async () => {
	const directory = await mkdtemp(join(tmpdir(), "axi-import-")),
		file = join(directory, "import.sqlite");
	try {
		const parts: ArchivePart[] = [
			{ kind: "manifest", format: 1, schema: 2, lastSeq: 0, nextId: 2 },
			{ kind: "end", writes: 1 },
		];
		await expect(importStore(sqliteBackend(await openNodeSqliteDatabase(file)), parts, context)).rejects.toThrow(
			"counts 1 writes",
		);
		const db = await openNodeSqliteDatabase(file);
		try {
			expect(await db.all("SELECT name FROM sqlite_master")).toEqual([]);
		} finally {
			await db.close();
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
it("rejects a divergent replay atomically and refuses later batches", async () => {
	const source = await fresh(),
		replica = await fresh();
	try {
		await prepareTables([{ table: "app:notes", definition }], source, fence, "app", context);
		const handle = new TableHandle(definition, "app:notes", source, owner),
			writes: StagedWrite[] = [],
			changes = new TableChanges(handle, writes);
		changes.put({ id: "a", n: 1 });
		changes.update({ id: "a" }, { n: 3 });
		await source.commit(writes, fence, context);
		const commits = structuredClone(await source.outbox!.read(0, 100, context));
		const wrong = commits.flatMap((commit) => commit.writes).find((write) => write.kind === "update");
		if (wrong?.kind !== "update") throw new Error("Missing update write");
		Object.assign(wrong, { count: 2 });
		await expect(applyBatch(replica, commits, context)).rejects.toThrow("changed 1 rows, recorded 2");
		expect(replica.lastSeq).toBe(0);
		await expect(applyBatch(replica, [], context)).rejects.toThrow("diverged");
	} finally {
		await source.close(context);
		await replica.close(context);
	}
});

it("migrates multiple chunks through messages when the Node yield function is unavailable", async () => {
	const source = await fresh();
	try {
		await prepareTables([{ table: "portable:notes", definition }], source, fence, "portable", context);
		const writes: StagedWrite[] = [],
			changes = new TableChanges(new TableHandle(definition, "portable:notes", source, owner), writes);
		for (let index = 0; index < 205; index++) changes.put({ id: String(index), n: index });
		await source.commit(writes, fence, context);
		const next = evolveTable(definition, (table) =>
			table.add("tag", str({ default: "" })).rows((row) => ({ tag: `row-${row.id}` })),
		);
		const immediate = Object.getOwnPropertyDescriptor(globalThis, "setImmediate");
		Object.defineProperty(globalThis, "setImmediate", { configurable: true, writable: true, value: undefined });
		try {
			await prepareTables([{ table: "portable:notes", definition: next }], source, fence, "portable", context);
		} finally {
			if (immediate) Object.defineProperty(globalThis, "setImmediate", immediate);
			else Reflect.deleteProperty(globalThis, "setImmediate");
		}
		const rows = await source.read(
			(db) =>
				db.all<{ total: number; migrated: number }>(
					`SELECT count(*) AS total, sum(CASE WHEN tag = 'row-' || id THEN 1 ELSE 0 END) AS migrated FROM "portable:notes"`,
				),
			context,
		);
		expect(rows).toEqual([{ total: 205, migrated: 205 }]);
		expect(source.table("portable:notes")).toMatchObject({ version: 2, state: "ready" });
	} finally {
		await source.close(context);
	}
});
