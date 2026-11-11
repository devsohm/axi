import { afterEach, expect, expectTypeOf, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import { checkAccepts } from "../src/contracts/accepts.ts";
import { contractData } from "../src/contracts/contract.ts";
import { type Address, evolve, hostKind, int, keyed, local, obj, str } from "../src/contracts/index.ts";
import { defineState, type KeyedHandle, type Tx } from "../src/documents/index.ts";
import { Persistence } from "../src/documents/persistence.ts";
import { createHost, defineFacet } from "../src/host/index.ts";
import { openNodeSqliteDatabase } from "../src/sqlite/node.ts";
import { listHostRecords } from "../src/store/engine.ts";
import { openStore, sqliteBackend } from "../src/store/index.ts";
import { ObjectsStore } from "../src/store/store.ts";

const Room = hostKind("room", { id: str() });
const valueSchema = obj({ count: int() });
const State = defineState("room-count", {
	schema: valueSchema,
	version: 1,
	keyed: Room,
	initial: () => ({ count: 0 }),
});
const Counts = local("test.room-counts", { version: 1, params: {}, members: { counts: keyed(valueSchema, Room) } });
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});
async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
	const result: T[] = [];
	for await (const value of values) result.push(value);
	return result;
}

async function fixture(persist = false) {
	const store = persist ? await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context) : undefined;
	if (store) cleanup.push(() => store.close(context));
	const host = createHost({ store, onError() {} });
	cleanup.push(() => host.close(context));
	let handle!: KeyedHandle<{ count: number }, Address<typeof Room>>;
	let transaction!: (fn: (tx: Tx) => Promise<void>) => Promise<void>;
	const definition = persist
		? defineState(State.name, {
				schema: valueSchema,
				version: 1,
				keyed: Room,
				initial: () => ({ count: 0 }),
				persist: true,
				checkpointWhen: () => false,
			})
		: State;
	const facets = [
		{
			name: "counts",
			facet: defineFacet((facet) =>
				facet.serve(Counts, (_, self) => {
					handle = self.state(definition);
					transaction = (fn) => self.tx(fn, context);
					return { counts: handle };
				}),
			),
		},
	];
	await host.load(facets, context);
	const reference = await host.get(Counts, {}, context);
	return {
		host,
		store,
		reference,
		facets,
		handle: () => handle,
		transaction: (fn: (tx: Tx) => Promise<void>) => transaction(fn),
	};
}

it("keeps address keys typed and canonical through reads, transactions and persisted reopening", async () => {
	const app = await fixture(true),
		address = Room({ id: "north|west\\wing" });
	expectTypeOf<Parameters<typeof app.reference.counts.get>[0]>().toEqualTypeOf<Address<typeof Room>>();
	await app.handle().change(
		{ ...address, key: "spoofed" },
		(draft) => {
			draft.count = 4;
		},
		context,
	);
	await app.transaction(async (tx) => {
		(await tx.draft(app.handle(), address)).count++;
	});
	expect(await app.reference.counts.get(address, context)).toEqual({ count: 5 });
	expect(await collect(app.handle().keys(context))).toEqual([address]);
	if (!(app.store instanceof ObjectsStore)) throw new Error("Expected SQLite store");
	expect(await app.store.read((db) => listHostRecords(db, address.key, 0, 10), context)).toMatchObject([
		{ owner: Counts.name, namespace: "objects", kind: State.name, key: address.key, host: address.key, revision: 2 },
	]);
	await app.host.reload([], context);
	await app.host.reload(app.facets, context);
	const reopened = await app.host.get(Counts, {}, context);
	expect(await reopened.counts.get(address, context)).toEqual({ count: 5 });
});

it("rejects bad keys through handles, references and transactions before writing", async () => {
	const app = await fixture();
	for (const key of [undefined, "", "room|x", { kind: "other", params: { id: "x" } }, Room({ id: "x\0y" })]) {
		await expect(app.handle().get(key as never, context)).rejects.toMatchObject({ code: "invalid", reason: "args" });
		await expect(app.handle().watch(key as never, context)).rejects.toMatchObject({ code: "invalid", reason: "args" });
		await expect(app.reference.counts.get(key as never, context)).rejects.toMatchObject({
			code: "invalid",
			reason: "args",
		});
		await expect(app.reference.counts.watch(key as never, context)).rejects.toMatchObject({
			code: "invalid",
			reason: "args",
		});
		await expect(
			app.transaction(async (tx) => {
				await tx.draft(app.handle(), key as never);
			}),
		).rejects.toMatchObject({ code: "invalid", reason: "args" });
		await expect(
			app.transaction(async (tx) => {
				await tx.retire(app.handle(), key as never);
			}),
		).rejects.toMatchObject({ code: "invalid", reason: "args" });
		expect(() => app.handle().at(key as never)).toThrow();
	}
	expect(await collect(app.handle().keys(context))).toEqual([]);
});

it("pins host keys through a re-export and follows retirement and recreation", async () => {
	const app = await fixture(),
		room = Room({ id: "a" });
	const Mirror = local("test.room-mirror", { version: 1, params: {}, members: { counts: keyed(valueSchema, Room) } });
	const Pinned = local("test.room-view", { version: 1, params: {}, members: { value: valueSchema } });
	await app.host.reload(
		[
			...app.facets,
			{
				name: "mirror",
				facet: defineFacet((facet) => facet.serve(Mirror, (_, self) => ({ counts: self.get(Counts, {}).counts }))),
			},
			{
				name: "view",
				facet: defineFacet((facet) =>
					facet.serve(Pinned, (_, self) => ({ value: self.get(Mirror, {}).counts.at(room) })),
				),
			},
		],
		context,
	);
	const mirror = await app.host.get(Mirror, {}, context),
		view = await app.host.get(Pinned, {}, context);
	await app.handle().change(
		room,
		(draft) => {
			draft.count = 8;
		},
		context,
	);
	expect(view.value.value).toEqual({ count: 8 });
	expect((await mirror.counts.watch(room, context))?.value).toEqual({ count: 8 });
	await app.handle().retire(room, context);
	expect(view.value.value).toEqual({ count: 0 });
	expect(await mirror.counts.get(room, context)).toBeUndefined();
	await app.handle().change(
		room,
		(draft) => {
			draft.count = 9;
		},
		context,
	);
	expect(view.value.value).toEqual({ count: 9 });
});

it("includes the key kind in contract fingerprints and refuses value-only adapters for a changed key kind", () => {
	const plain = local(Counts.name, { version: 1, params: {}, members: { counts: keyed(valueSchema) } });
	const changed = evolve(plain, (editor) => editor.keyed("counts", valueSchema, Room));
	expect(changed.fingerprint).not.toBe(plain.fingerprint);
	expect(Counts.fingerprint).toBe(changed.fingerprint);
	expect(contractData(plain).versions[0]!.variants.get("members")!.keyed.get("counts")!.key).toBeUndefined();
	expect(() => checkAccepts(changed, { 1: { keyed: { counts: (value) => value } } })).toThrow(
		"a value mapping cannot map keys",
	);
	expect(checkAccepts(changed, { 1: { keyed: { counts: "refuse" } } }).versions).toEqual([
		{ version: 1, fingerprint: plain.fingerprint },
	]);
	expect(() =>
		defineState("invalid", {
			schema: valueSchema,
			version: 1,
			initial: () => ({ count: 0 }),
			keyed: { kind: "room" } as typeof Room,
		}),
	).toThrow("not a declared host kind");
});

it("refuses string-keyed implementations and persisted records without a host discriminator", async () => {
	const app = await fixture(true);
	const plain = defineState(State.name, {
		schema: valueSchema,
		version: 1,
		keyed: true,
		initial: () => ({ count: 0 }),
	});
	const report = await app.host.reload(
		[
			{
				name: "counts",
				facet: defineFacet((facet) => facet.serve(Counts, (_, self) => ({ counts: self.state(plain) as never }))),
			},
		],
		context,
	);
	expect(report.failed).toMatchObject([
		{
			plugin: "counts",
			error: expect.objectContaining({
				message: expect.stringContaining("declared with string keys, its documents have addresses of room"),
			}),
		},
	]);
	expect(app.reference.state.value.kind).toBe("live");
	if (!(app.store instanceof ObjectsStore)) throw new Error("Expected SQLite store");
	const hostPersistence = new Persistence(app.store, Counts.name, "objects", State.name, Room);
	const plainPersistence = new Persistence(app.store, Counts.name, "objects", State.name);
	expect(() => hostPersistence.checkHost(undefined, State)).toThrow("convert it explicitly");
	expect(() => plainPersistence.checkHost(Room({ id: "a" }).key, plain)).toThrow("stored with addresses of room");
});
