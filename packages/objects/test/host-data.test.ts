import { afterEach, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context, withCancel } from "../src/context/index.ts";
import { arr, hostKind, int, keyed, local, method, obj, str } from "../src/contracts/index.ts";
import { defineState, type Tx } from "../src/documents/index.ts";
import { createHost, defineFacet } from "../src/host/index.ts";
import { HostDataGate } from "../src/host/host-data.ts";
import { openNodeSqliteDatabase } from "../src/sqlite/node.ts";
import {
	eq,
	evolveTable,
	host,
	json,
	openStore,
	query,
	readHostArchive,
	sqliteBackend,
	defineTable,
} from "../src/store/index.ts";

const Room = hostKind("room", { id: str() }),
	left = Room({ id: "left" }),
	right = Room({ id: "right" });
const schema = obj({ count: int() });
const Counter = defineState("counter", {
	schema,
	version: 1,
	keyed: Room,
	persist: true,
	checkpointWhen: () => false,
	initial: () => ({ count: 0 }),
});
const Plain = defineState("plain", {
	schema,
	version: 1,
	keyed: true,
	persist: true,
	checkpointWhen: () => false,
	initial: () => ({ count: 0 }),
});
const Rows = defineTable("items", {
	version: 1,
	columns: { room: host(Room), id: str(), note: json(obj({ origin: str() }), { version: 1 }) },
	key: ["room", "id"],
});
const Board = local("test.host-data", {
	version: 1,
	params: {},
	members: { counts: keyed(schema, Room), summary: str() },
});
const closes: (() => Promise<void>)[] = [];
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
afterEach(async () => {
	for (const close of closes.splice(0).reverse()) await close();
});
async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
	const result: T[] = [];
	for await (const value of values) result.push(value);
	return result;
}
async function fixture() {
	const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context, { outbox: true });
	closes.push(() => store.close(context));
	const app = createHost({ store, onError() {} });
	closes.push(() => app.close(context));
	let write!: (id: string, count: number, names: string[]) => Promise<void>;
	let plain!: (key: string) => Promise<unknown>;
	let transaction!: (fn: (tx: Tx) => Promise<void>) => Promise<void>;
	await app.load(
		[
			{
				name: "data",
				facet: defineFacet((facet) =>
					facet.serve(Board, (_, self) => {
						const counts = self.state(Counter),
							plainCounts = self.state(Plain),
							table = self.table(Rows);
						const pinned = counts.at(left),
							rows = self.query(
								table,
								query(Rows).where((row) => eq(row.room, left)),
								100,
							);
						write = (id, count, names) =>
							self.tx(async (tx) => {
								const address = Room({ id });
								(await tx.draft(counts, address)).count = count;
								(await tx.draft(plainCounts, address.key)).count = count;
								for (const name of names) tx.put(table, { room: address, id: name, note: { origin: address.key } });
							}, context);
						plain = (key) => plainCounts.get(key, context);
						transaction = (fn) => self.tx(fn, context);
						return {
							counts,
							summary: self.derive([pinned, rows], ([counter, values]) => `${counter.count}:${values.length}`),
						};
					}),
				),
			},
		],
		context,
	);
	return {
		app,
		store,
		reference: await app.get(Board, {}, context),
		write: (id: string, count: number, names: string[]) => write(id, count, names),
		plain: (key: string) => plain(key),
		transaction: (fn: (tx: Tx) => Promise<void>) => transaction(fn),
	};
}

it("exports, deletes and restores one address, publishing documents and queries together", async () => {
	const f = await fixture();
	await f.write("left", 12, ["a", "b"]);
	await f.write("right", 7, ["c"]);
	const parts = await collect(f.app.exportHostData(left, context));
	expect(parts[0]).toMatchObject({ kind: "manifest", host: left.key });
	expect(parts.filter((part) => part.kind === "document.create")).toHaveLength(1);
	const seq = f.store.lastSeq;
	expect(await f.app.deleteHostData(left, context)).toEqual({ documents: 1, rows: 2 });
	expect(f.store.lastSeq).toBe(seq + 1);
	expect(f.reference.summary.value).toBe("0:0");
	expect(await f.plain(left.key)).toEqual({ count: 12 });
	await f.write("left", 99, ["temporary"]);
	const values: string[] = [],
		watch = await f.reference.summary.watch(context);
	watch.start(async (frame) => {
		if (frame.kind === "value") values.push(frame.value);
	});
	expect(await f.app.importHostData(parts, context, { existing: "replace" })).toEqual({ documents: 1, rows: 2 });
	await turn();
	expect(values).toEqual(["12:2"]);
	expect(await f.reference.counts.get(right, context)).toEqual({ count: 7 });
	expect(await f.plain(left.key)).toEqual({ count: 99 });
	await watch.stop();
});

it("copies only ownership keys and rejects collisions without publishing a partial replacement", async () => {
	const f = await fixture();
	await f.write("left", 5, ["a"]);
	const parts = await collect(f.app.exportHostData(left, context));
	await f.app.importHostData(parts, context, { address: right });
	const copied = await collect(f.app.exportHostData(right, context));
	expect(copied.find((part) => part.kind === "put")).toMatchObject({
		row: { room: right.key, note: { origin: left.key } },
	});
	const seq = f.store.lastSeq;
	await expect(f.app.importHostData(parts, context)).rejects.toThrow("has data in this store");
	await expect(
		f.app.importHostData(parts, context, { address: { kind: "user", key: "user|a", params: { id: "a" } } }),
	).rejects.toThrow("another kind");
	expect(f.store.lastSeq).toBe(seq);
	expect(f.reference.summary.value).toBe("5:1");
});

it("validates archive order, ownership and document revisions before admitting a commit", async () => {
	const f = await fixture();
	await f.write("left", 3, ["a"]);
	const parts = await collect(f.app.exportHostData(left, context));
	const invalid = [
		parts.slice(0, -1),
		[...parts, parts[0]],
		parts.map((part) => (part.kind === "manifest" ? { ...part, host: undefined } : part)),
		parts.map((part) => (part.kind === "put" ? { ...part, row: { ...part.row, room: right.key } } : part)),
		parts.map((part) =>
			part.kind === "document.create" ? { ...part, record: { ...part.record, history: "latest" } } : part,
		),
		parts
			.filter((part) => part.kind !== "document.revision")
			.map((part) => (part.kind === "end" ? { ...part, writes: part.writes - 1 } : part)),
	];
	const seq = f.store.lastSeq;
	for (const archive of invalid) {
		await expect(readHostArchive(archive, context)).rejects.toMatchObject({ code: "invalid", reason: "args" });
		await expect(f.app.importHostData(archive, context, { existing: "replace" })).rejects.toMatchObject({
			code: "invalid",
		});
	}
	expect(f.store.lastSeq).toBe(seq);
	expect(f.reference.summary.value).toBe("3:1");
});

it("rejects ambiguous archive groups and invalid revision chains", async () => {
	const f = await fixture();
	await f.write("left", 3, ["a"]);
	const parts = await collect(f.app.exportHostData(left, context));
	const manifest = parts.find((part) => part.kind === "manifest")!;
	const table = parts.find((part) => part.kind === "table")!;
	const put = parts.find((part) => part.kind === "put")!;
	const record = parts.find((part) => part.kind === "document.create")!;
	const revision = parts.find((part) => part.kind === "document.revision")!;
	const archive = (items: unknown[]) => [manifest, ...items, { kind: "end", writes: items.length }];
	const cases: [unknown[], string][] = [
		[[{ kind: "end", writes: 0 }], "manifest comes first"],
		[
			[
				{ ...manifest, format: 99 },
				{ kind: "end", writes: 0 },
			],
			"format 99",
		],
		[
			[
				{ ...manifest, schema: 99 },
				{ kind: "end", writes: 0 },
			],
			"schema 99",
		],
		[archive([manifest]), "manifest comes first"],
		[archive([table, table]), "occurs twice"],
		[archive([put]), "a put follows its table"],
		[archive([{ kind: "index", table: table.table, name: "by_id", columns: ["id"] }]), "an index follows"],
		[
			archive([table, { kind: "index", table: table.table, name: "by_id", columns: ["id"] }, put]),
			"before its indexes",
		],
		[archive([record, revision, table]), "tables come before"],
		[archive([record, revision, record]), "second record"],
		[archive([{ ...record, record: { ...record.record, key: right.key } }, revision]), "does not belong"],
		[archive([{ ...record, record: { ...record.record, owner: "owner\uD800" } }, revision]), "not well-formed text"],
		[archive([revision]), "revision follows its record"],
		[archive([record, revision, revision]), "in seq order"],
		[archive([record, { ...revision, id: revision.id + 1 }]), "revision follows its record"],
		[archive([record, { ...revision, content: { kind: "delta", version: 1, ops: [] } }]), "without a base"],
		[
			archive([
				record,
				revision,
				{ ...revision, seq: revision.seq + 1, content: { kind: "delta", version: 1, ops: [["invalid-operation"]] } },
			]),
			"delta that does not apply",
		],
	];
	for (const [parts, message] of cases) await expect(readHostArchive(parts, context)).rejects.toThrow(message);
	const folded = await readHostArchive(
		archive([
			record,
			revision,
			{ ...revision, seq: revision.seq + 1, content: { kind: "delta", version: 1, ops: [["s", ["count"], 10]] } },
		]),
		context,
	);
	expect(folded.documents[0]!.value).toEqual({ count: 10 });
});

it("cancels an operation waiting on an owner's line and leaves its data intact", async () => {
	const f = await fixture();
	await f.write("left", 4, ["a"]);
	const entered = Promise.withResolvers<void>(),
		released = Promise.withResolvers<void>();
	const holding = f.transaction(async () => {
		entered.resolve();
		await released.promise;
	});
	await entered.promise;
	const { context: cancellable, cancel } = withCancel(context);
	const deleting = f.app.deleteHostData(left, cancellable);
	const rejected = expect(deleting).rejects.toThrow("cancelled locally");
	try {
		await turn();
		const seq = f.store.lastSeq;
		cancel(new Error("cancelled locally"));
		await rejected;
		expect(f.store.lastSeq).toBe(seq);
		expect(f.reference.summary.value).toBe("4:1");
	} finally {
		released.resolve();
		await holding;
	}
	expect(await f.app.deleteHostData(left, context)).toEqual({ documents: 1, rows: 1 });
});

it("migrates imported table rows through their live owner's declared history", async () => {
	const source = await fixture();
	await source.write("left", 8, ["first"]);
	const archive = await collect(source.app.exportHostData(left, context));
	const version2 = evolveTable(Rows, (table) =>
		table.add("label", str({ default: "" })).rows((row) => ({ label: row.id.toUpperCase() })),
	);
	const Reader = local(Board.name, { version: 1, params: {}, members: { labels: method(undefined, arr(str())) } });
	const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context);
	closes.push(() => store.close(context));
	const target = createHost({ store, onError() {} });
	closes.push(() => target.close(context));
	await target.load(
		[
			{
				name: "data",
				facet: defineFacet((facet) =>
					facet.serve(Reader, (_, self) => {
						const table = self.table(version2);
						return {
							labels: async (ctx) => (await table.page(query(version2), 10, ctx)).items.map((row) => row.label),
						};
					}),
				),
			},
		],
		context,
	);
	await target.importHostData(archive, context);
	expect(await (await target.get(Reader, {}, context)).labels(context)).toEqual(["FIRST"]);
});

it("lets earlier readers drain, blocks new readers during a write and preserves queue order after cancellation", async () => {
	const gate = new HostDataGate(),
		order: string[] = [];
	expect(gate.enter()).toBeUndefined();
	const held = Promise.withResolvers<void>();
	const first = gate.turn(
		(exclusive) =>
			exclusive(async () => {
				order.push("write");
				await held.promise;
			}),
		context,
	);
	await turn();
	const reading = gate.enter()!.then(() => {
		order.push("read");
		gate.leave();
	});
	const { context: cancellable, cancel } = withCancel(context);
	const cancelled = gate.turn(async () => {
		order.push("skipped");
	}, cancellable);
	const rejected = expect(cancelled).rejects.toThrow("cancel");
	const last = gate.turn(async () => {
		order.push("last");
	}, context);
	cancel(new Error("cancel"));
	await rejected;
	expect(order).toEqual([]);
	gate.leave();
	await turn();
	expect(order).toEqual(["write"]);
	held.resolve();
	await Promise.all([first, reading, last]);
	expect(order).toEqual(["write", "read", "last"]);
});
