import { afterEach, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import { bool, hostKind, int, local, obj, opt, str } from "../src/contracts/index.ts";
import { createHost, defineFacet } from "../src/host/index.ts";
import { openNodeSqliteDatabase } from "../src/sqlite/node.ts";
import {
	defineTable,
	eq,
	evolveTable,
	host,
	json,
	openStore,
	sqliteBackend,
	type ArchivePart,
	type TableDefinition,
} from "../src/store/index.ts";

const Room = hostKind("room", { id: str() }),
	address = Room({ id: "a" });
const First = defineTable("rows", {
	version: 1,
	columns: {
		room: host(Room),
		id: str(),
		n: int(),
		enabled: bool({ default: true }),
		gone: opt(str()),
		meta: opt(json(obj({ n: int() }), { version: 1 })),
	},
	key: ["room", "id"],
});
const Second = evolveTable(First, (table) =>
	table
		.rename("n", "score")
		.json(
			"meta",
			json(obj({ n: int(), tag: str() }), {
				version: 2,
				migrate: (old) => ({ ...(old as { n: number }), tag: "old" }),
			}),
		)
		.add("label", str({ default: "none" }))
		.rows((row) => ({
			score: row.score * 3,
			...(row.id === "touched" ? { meta: { n: row.meta!.n, tag: "new" } } : {}),
		}))
		.drop("gone")
		.index("score", ["score"]),
);
const Third = evolveTable(Second, (table) =>
	table.update({ where: (row) => eq(row.id, "touched"), set: { enabled: false, label: "marked" } }).dropIndex("score"),
);
const Owner = local("test.import-history", { version: 1, params: {}, members: {} });
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});
async function target(definition: TableDefinition = Third) {
	const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context);
	cleanup.push(() => store.close(context));
	const app = createHost({ store, onError() {} });
	cleanup.push(() => app.close(context));
	await app.load(
		[
			{
				name: "data",
				facet: defineFacet((facet) =>
					facet.serve(Owner, (_, self) => {
						self.table(definition);
						return {};
					}),
				),
			},
		],
		context,
	);
	return { app, store };
}
function archive(
	definition: TableDefinition,
	rows: readonly Record<string, unknown>[],
	options: {
		migrating?: boolean;
		layout?: TableDefinition;
		versions?: readonly number[];
		cells?: readonly number[];
	} = {},
): unknown[] {
	const name = `${Owner.name}:rows`,
		layout = options.layout ?? definition;
	const parts: unknown[] = [
		{
			kind: "table",
			table: name,
			version: definition.version,
			state: options.migrating ? "migrating" : "ready",
			columns: layout.record,
			key: layout.key,
			fingerprint: definition.fingerprint,
		},
	];
	for (const [index, row] of rows.entries())
		parts.push({
			kind: "put",
			table: name,
			row: { room: address.key, ...row },
			version: options.versions?.[index] ?? 1,
			columns: row.meta === undefined ? {} : { meta: options.cells?.[index] ?? 1 },
		});
	return [
		{ kind: "manifest", format: 1, schema: 3, lastSeq: 1, nextId: 2, host: address.key },
		...parts,
		{ kind: "end", writes: parts.length },
	];
}
async function exported(
	app: Awaited<ReturnType<typeof target>>["app"],
): Promise<Extract<ArchivePart, { kind: "put" }>[]> {
	const rows: Extract<ArchivePart, { kind: "put" }>[] = [];
	for await (const part of app.exportHostData(address, context)) if (part.kind === "put") rows.push(part);
	return rows;
}

it("preserves row and JSON cell versions through ordered edits and conditional migration steps", async () => {
	const t = await target();
	await t.app.importHostData(
		archive(First, [
			{ id: "absent", n: 2, enabled: false },
			{ id: "touched", n: 1, enabled: true, gone: "remove", meta: { n: 1 } },
			{ id: "untouched", n: 4, enabled: true, meta: { n: 4 } },
		]),
		context,
	);
	expect((await exported(t.app)).map(({ row, version, columns }) => ({ row, version, columns }))).toEqual([
		{ row: { room: address.key, id: "absent", score: 6, enabled: false, label: "none" }, version: 2, columns: {} },
		{
			row: { room: address.key, id: "touched", score: 3, enabled: false, label: "marked", meta: { n: 1, tag: "new" } },
			version: 3,
			columns: { meta: 2 },
		},
		{
			row: { room: address.key, id: "untouched", score: 12, enabled: true, label: "none", meta: { n: 4 } },
			version: 2,
			columns: { meta: 1 },
		},
	]);
});

it("resumes unfinished migration steps while leaving already stamped rows unchanged", async () => {
	const t = await target();
	await t.app.importHostData(
		archive(
			Second,
			[
				{ id: "pending", score: 2, enabled: true, label: "none" },
				{ id: "finished", score: 9, enabled: false, label: "none" },
			],
			{ migrating: true, layout: Second.evolution!.migration.step!.table, versions: [1, 2] },
		),
		context,
	);
	expect((await exported(t.app)).map(({ row, version }) => [row.id, row.score, version])).toEqual([
		["finished", 9, 2],
		["pending", 6, 2],
	]);
	const seq = t.store.lastSeq;
	await expect(
		t.app.importHostData(archive(First, [], { migrating: true }), context, { existing: "replace" }),
	).rejects.toThrow("no data step to resume");
	expect(t.store.lastSeq).toBe(seq);
});

it("refuses an imported table newer than its owner without changing existing data", async () => {
	const t = await target(First);
	const before = t.store.lastSeq;
	await expect(t.app.importHostData(archive(Third, []), context)).rejects.toThrow("newer than 1 here");
	expect(t.store.lastSeq).toBe(before);
	expect(await exported(t.app)).toEqual([]);
});
