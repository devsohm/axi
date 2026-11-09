import { LiveQueries } from "../src/store/live-query.ts";
import { afterEach, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import { defineState, defineTable, int, obj, openStore, sqliteBackend, str } from "../src/index.ts";
import { Documents, SealToken, type AnyDefinition } from "../src/documents/internal.ts";
import type { KeyDeclarer } from "../src/documents/handles.ts";
import type { StateDefinition, JsonObject } from "../src/documents/definition.ts";
import { Batch } from "../src/state/internal.ts";
import { ObjectsStore } from "../src/store/store.ts";
import { TableHandle } from "../src/store/table-handle.ts";
import { prepareTables } from "../src/store/table-migration.ts";
import { openNodeSqliteDatabase } from "../src/sqlite/node.ts";

const Note = defineState("note", {
	schema: obj({ text: str() }),
	version: 1,
	initial: () => ({ text: "" }),
});
const Drafts = defineState("drafts", {
	schema: obj({ n: int() }),
	version: 1,
	keyed: true,
	initial: () => ({ n: 0 }),
});
const Saved = defineState("saved", {
	schema: obj({ n: int() }),
	version: 1,
	keyed: true,
	persist: true,
	initial: () => ({ n: 0 }),
	checkpointWhen: () => false,
});
const close: (() => Promise<void>)[] = [];
const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
afterEach(async () => {
	for (const release of close.splice(0).reverse()) await release();
});
async function store(): Promise<ObjectsStore> {
	const value = await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context, { outbox: true });
	if (!(value instanceof ObjectsStore)) throw new Error("Unexpected Store implementation");
	close.push(() => value.close(context));
	return value;
}
function owner(store?: ObjectsStore) {
	const errors: unknown[] = [],
		batch = new Batch((error) => errors.push(error), undefined);
	const documents = new Documents({
		label: "app.owner",
		context,
		batch,
		store: store ? { store, owner: "app.owner" } : undefined,
		fail: (error) => errors.push(error),
	});
	let ended = false;
	const end = async (): Promise<void> => {
		if (!ended) {
			ended = true;
			documents.seal();
			await documents.settled();
			documents.end();
		}
	};
	close.push(end);
	function attempt() {
		const token = new SealToken(),
			definitions = new Map<string, AnyDefinition>(),
			pins: (() => void)[] = [];
		const declarer: KeyDeclarer = {
			at(slot, key) {
				pins.push(slot.pin(key, context));
				return slot.source(key);
			},
		};
		return {
			token,
			state<D extends StateDefinition<JsonObject, boolean, boolean>>(definition: D) {
				definitions.set(definition.name, definition);
				return documents.declare(definition, token, declarer);
			},
			async ready() {
				documents.hydrate(definitions, pins, context);
				await documents.load(context);
			},
		};
	}
	return { documents, errors, batch, attempt, end };
}

it("keeps committed values atomic across document watchers and discards a failed callback", async () => {
	const app = owner(),
		a = app.attempt(),
		note = a.state(Note),
		drafts = a.state(Drafts);
	await a.ready();
	const watch = await note.watch(context),
		seen: unknown[] = [];
	watch.start(async (call) => {
		if (call.kind === "value") seen.push([call.value.text, await drafts.get("a", context)]);
	});
	await app.documents.tx(
		async (tx) => {
			(await tx.draft(note)).text = "saved";
			(await tx.draft(drafts, "a")).n = 7;
		},
		a.token,
		context,
	);
	await turn();
	expect(seen).toEqual([["saved", { n: 7 }]]);
	await expect(
		app.documents.tx(
			async (tx) => {
				(await tx.draft(note)).text = "lost";
				(await tx.draft(drafts, "a")).n = 9;
				throw new Error("cancel commit");
			},
			a.token,
			context,
		),
	).rejects.toThrow("cancel commit");
	expect([note.value, await drafts.get("a", context)]).toEqual([{ text: "saved" }, { n: 7 }]);
	expect(app.errors).toEqual([]);
});

it("retires and recreates one address in one frame and drops undeclared slots", async () => {
	const app = owner(),
		a = app.attempt(),
		note = a.state(Note);
	await a.ready();
	await note.change((draft) => {
		draft.text = "old";
	}, context);
	const watch = await note.watch(context),
		calls: unknown[] = [];
	watch.start(async (call) => {
		calls.push(call);
	});
	await app.documents.tx(
		async (tx) => {
			await tx.retire(note);
			(await tx.draft(note)).text = "new";
		},
		a.token,
		context,
	);
	await turn();
	expect(calls).toEqual([
		{
			kind: "value",
			value: { text: "new" },
			ops: [["r", { text: "new" }]],
			retired: true,
		},
	]);
	await app.attempt().ready();
	expect(await watch.closed).toEqual({ kind: "ended" });
});

it("cuts a stalled transaction, frees the line, and refuses its eventual commit", async () => {
	const app = owner(),
		a = app.attempt(),
		note = a.state(Note);
	await a.ready();
	const entered = Promise.withResolvers<void>(),
		finish = Promise.withResolvers<void>();
	const first = app.documents.tx(
		async (tx) => {
			(await tx.draft(note)).text = "discarded";
			entered.resolve();
			await finish.promise;
		},
		a.token,
		context,
	);
	await entered.promise;
	app.documents.fence(a.token);
	const b = app.attempt(),
		current = b.state(Note);
	await b.ready();
	await current.change((draft) => {
		draft.text = "successor";
	}, context);
	finish.resolve();
	await expect(first).rejects.toMatchObject({
		code: "released",
		reason: "discarded",
	});
	expect(note.value).toEqual({ text: "successor" });
	await expect(note.change(() => {}, context)).rejects.toMatchObject({
		code: "released",
	});
});

it("migrates singleton and keyed values between attempts and refuses older handles", async () => {
	const app = owner(),
		a = app.attempt(),
		note = a.state(Note),
		drafts = a.state(Drafts);
	await a.ready();
	await note.change((d) => {
		d.text = "first";
	}, context);
	await drafts.change(
		"x",
		(d) => {
			d.n = 4;
		},
		context,
	);
	const b = app.attempt();
	const newNote = b.state(
		defineState("note", {
			schema: obj({ text: str() }),
			version: 2,
			initial: () => ({ text: "" }),
			migrate: (old) => ({ text: String(old.text) + "!" }),
		}),
	);
	const DraftsV2 = defineState("drafts", {
		schema: obj({ n: int() }),
		version: 2,
		keyed: true,
		initial: () => ({ n: 0 }),
		migrate: (old) => ({ n: Number(old.n) * 2 }),
	});
	const newDrafts = b.state(DraftsV2);
	expect(() => newNote.value).toThrow("until the activation migrates them");
	await b.ready();
	expect([newNote.value, await newDrafts.get("x", context)]).toEqual([{ text: "first!" }, { n: 8 }]);
	expect(() => note.value).toThrow("a handle of version 1");
	await expect(drafts.get("x", context)).rejects.toMatchObject({
		code: "released",
		reason: "version",
	});
});

it("restores persisted keyed state and shares concurrent cold loads", async () => {
	const disk = await store(),
		app = owner(disk),
		a = app.attempt(),
		saved = a.state(Saved);
	await a.ready();
	await saved.change(
		"x",
		(d) => {
			d.n = 42;
		},
		context,
	);
	await app.end();
	const reopened = owner(disk),
		b = reopened.attempt(),
		restored = b.state(Saved);
	await b.ready();
	const read = vi.spyOn(disk, "read");
	expect(await Promise.all([restored.get("x", context), restored.get("x", context)])).toEqual([{ n: 42 }, { n: 42 }]);
	expect(read.mock.calls.length).toBe(1);
	const keys: string[] = [];
	for await (const key of restored.keys(context)) keys.push(key);
	expect(keys).toEqual(["x"]);
});

it("follows a pinned key across retirement and recreation", async () => {
	const app = owner(),
		a = app.attempt(),
		drafts = a.state(Drafts),
		pinned = drafts.at("k");
	await a.ready();
	const watch = await pinned.watch(context),
		values: unknown[] = [];
	watch.start(async (call) => {
		if (call.kind === "value") values.push([call.value, call.retired]);
	});
	await drafts.change(
		"k",
		(d) => {
			d.n = 1;
		},
		context,
	);
	await drafts.retire("k", context);
	await drafts.change(
		"k",
		(d) => {
			d.n = 2;
		},
		context,
	);
	await turn();
	expect(values).toEqual([
		[{ n: 1 }, false],
		[{ n: 0 }, true],
		[{ n: 2 }, false],
	]);
});

it("commits table changes with document changes and preserves both when a column rejects a write", async () => {
	const disk = await store(),
		app = owner(disk),
		a = app.attempt(),
		saved = a.state(Saved);
	await a.ready();
	const definition = defineTable("rows", {
		version: 1,
		columns: { id: str(), n: int() },
		key: ["id"],
	});
	await prepareTables(
		[{ table: "app.owner:rows", definition }],
		disk,
		{ admit: () => true, adopt: () => {} },
		"app.owner",
		context,
	);
	const table = new TableHandle(definition, "app.owner:rows", disk, {
		label: "app.owner",
		scope: app.documents,
		queries: new LiveQueries(),
		assertLive() {},
		fail(error) {
			app.errors.push(error);
		},
	});
	await app.documents.tx(
		async (tx) => {
			tx.put(table, { id: "a", n: 3 });
			expect(await tx.get(table, { id: "a" })).toEqual({ id: "a", n: 3 });
			(await tx.draft(saved, "x")).n = 3;
		},
		a.token,
		context,
	);
	await expect(
		app.documents.tx(
			async (tx) => {
				(await tx.draft(saved, "x")).n = 9;
				tx.update(table, { id: "a" }, { n: 1.5 });
			},
			a.token,
			context,
		),
	).rejects.toThrow();
	expect([await table.get({ id: "a" }, context), await saved.get("x", context)]).toEqual([{ id: "a", n: 3 }, { n: 3 }]);
});

it("rejects a queued Store commit as soon as its attempt is sealed", async () => {
	const disk = await store(),
		app = owner(disk),
		a = app.attempt(),
		saved = a.state(Saved);
	await a.ready();
	await saved.change(
		"x",
		(d) => {
			d.n = 1;
		},
		context,
	);
	const entered = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	const blocking = disk.commit(
		[
			{
				order: "write",
				async apply() {
					entered.resolve();
					await release.promise;
					return [];
				},
			},
		],
		{ admit: () => true, adopt: () => {} },
		context,
	);
	await entered.promise;
	const pending = saved.change(
		"x",
		(d) => {
			d.n = 10;
		},
		context,
	);
	await turn();
	app.documents.fence(a.token);
	try {
		await expect(pending).rejects.toMatchObject({
			code: "released",
			reason: "discarded",
		});
	} finally {
		release.resolve();
		await blocking;
	}
	const b = app.attempt(),
		current = b.state(Saved);
	await b.ready();
	await current.change(
		"x",
		(d) => {
			d.n = 2;
		},
		context,
	);
	expect(await current.get("x", context)).toEqual({ n: 2 });
});
