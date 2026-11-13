import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import { importStore, sqliteBackend, type ArchivePart } from "../src/store/index.ts";
import { openNodeSqliteDatabase } from "../src/sqlite/node.ts";

const manifest = { kind: "manifest", format: 1, schema: 2, lastSeq: 5, nextId: 4 } as const;
const record = {
	id: 1,
	owner: "app",
	namespace: "notes",
	kind: "note",
	history: "rewindable",
	createdAt: 1,
	revision: 1,
	version: 1,
	fingerprint: "note-v1",
} as const;
const created = { kind: "document.create", record } as const;
const base = {
	kind: "document.revision",
	id: 1,
	seq: 1,
	content: { kind: "base", version: 1, value: { text: "saved" } },
} as const;
const table = {
	kind: "table",
	table: "app:notes",
	version: 1,
	state: "ready",
	columns: { id: { type: "str" } },
	key: ["id"],
	fingerprint: "notes-v1",
} as const;
const end = (writes: number) => ({ kind: "end", writes });

const malformed: [string, unknown[], string][] = [
	["missing manifest", [created], "manifest comes first"],
	["repeated manifest", [manifest, manifest], "manifest comes first"],
	["new archive format", [{ ...manifest, format: 2 }], "format 2 is not"],
	["new store schema", [{ ...manifest, schema: 1000 }], "newer than"],
	["host archive", [{ ...manifest, host: "host-address" }], "importHostData"],
	["missing end", [manifest], "no end part"],
	["trailing part", [manifest, end(0), end(0)], "after the end"],
	["repeated table", [manifest, table, table], "occurs twice"],
	["table after documents", [manifest, created, base, table], "tables come before"],
	[
		"row before table",
		[manifest, { kind: "put", table: table.table, row: { id: "a" }, version: 1, columns: {} }],
		"a put follows",
	],
	[
		"index before table",
		[manifest, { kind: "index", table: table.table, name: "by_id", columns: ["id"] }],
		"an index follows",
	],
	["duplicate document ID", [manifest, created, base, created], "id 1 occurs twice"],
	[
		"overlapping document lifetimes",
		[manifest, created, base, { ...created, record: { ...record, id: 2 } }],
		"overlapping lifetime",
	],
	["revision before its document", [manifest, base], "a revision follows"],
	["revision from another document", [manifest, created, { ...base, id: 2 }], "a revision follows"],
	["revision beyond history", [manifest, created, { ...base, seq: 6 }], "outside its lifetime"],
	["repeated revision sequence", [manifest, created, base, base], "out of seq order"],
	[
		"delta without a base",
		[manifest, created, { ...base, content: { kind: "delta", version: 1, ops: [] } }],
		"delta without a base",
	],
	[
		"delta changes schema version",
		[manifest, created, base, { ...base, seq: 2, content: { kind: "delta", version: 2, ops: [] } }],
		"delta without a base",
	],
	["record without a base", [manifest, created, end(1)], "no base at its version"],
	[
		"base has an older version",
		[manifest, { ...created, record: { ...record, version: 2 } }, base, end(2)],
		"no base at its version",
	],
	[
		"retired latest record has a revision",
		[manifest, { ...created, record: { ...record, history: "latest", retiredAt: 2 } }, base],
		"keeps no revisions",
	],
	...(
		[
			["ID beyond allocator", { id: 4 }, "not below"],
			["creation beyond history", { createdAt: 6 }, "lifetime outside"],
			["retirement before creation", { createdAt: 3, retiredAt: 2 }, "lifetime outside"],
			["retirement beyond history", { retiredAt: 6 }, "lifetime outside"],
			["malformed owner", { owner: "bad\ud800" }, "not well-formed text"],
			["malformed metadata", { meta: "bad\ud800" }, "meta is not well-formed text"],
		] satisfies [string, object, string][]
	).map(([label, change, message]): [string, unknown[], string] => [
		label,
		[manifest, { ...created, record: { ...record, ...change } }],
		message,
	]),
];

test.each(malformed)("import rejects %s and rolls back schema creation", async (_label, parts, message) => {
	const directory = await mkdtemp(join(tmpdir(), "axi-import-boundary-"));
	const file = join(directory, "store.sqlite");
	try {
		await expect(importStore(sqliteBackend(await openNodeSqliteDatabase(file)), parts, context)).rejects.toMatchObject({
			code: "invalid",
			message: expect.stringContaining(message),
		});
		const reopened = await openNodeSqliteDatabase(file);
		try {
			expect(await reopened.all("SELECT name FROM sqlite_master")).toEqual([]);
		} finally {
			await reopened.close();
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("nonoverlapping document incarnations and retired latest documents survive archive round trips", async () => {
	const parts: ArchivePart[] = [
		manifest,
		{ ...created, record: { ...record, retiredAt: 2 } },
		base,
		{ ...created, record: { ...record, id: 2, createdAt: 2 } },
		{ ...base, id: 2, seq: 2 },
		{ ...created, record: { ...record, id: 3, key: "retired", history: "latest", retiredAt: 2 } },
		{ kind: "end", writes: 5 },
	];
	const store = await importStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), parts, context);
	try {
		const output: ArchivePart[] = [];
		for await (const part of store.export(context)) output.push(part);
		expect(output).toEqual([{ ...manifest, schema: 3 }, ...parts.slice(1)]);
	} finally {
		await store.close(context);
	}
});
