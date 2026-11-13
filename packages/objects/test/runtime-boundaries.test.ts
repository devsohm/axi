import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryTelemetryContext } from "@axi/telemetry";
import { expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context, withAbortSignal } from "../src/context/index.ts";
import { arr, constant, createHost, defineFacet, defineRegistry, defineTable, int, local, method, obj, query, sqliteBackend, openStore, str, type StoreSelf } from "../src/index.ts";
import { createHttp, Http } from "../src/node/http/index.ts";
import { clearStaleLockAt, lockAt, processLock } from "../src/node/workers/lock.ts";
import { openNodeSqliteDatabase } from "../src/sqlite/node.ts";

it("rejects local reads before load and permits them after publication", async () => {
	const host = createHost({ onError() {} });
	const item = local("ready", { version: 1, params: {}, members: { value: int() } });
	const registry = defineRegistry<unknown, unknown[]>("ready.values", { version: 1 });
	try {
		await expect(host.get(item, {}, context)).rejects.toMatchObject({ code: "not_ready" });
		expect(() => host.hold(item, {}, context)).toThrow("call host.load first");
		await expect(host.registry(registry, context)).rejects.toMatchObject({ code: "not_ready" });
		await host.load([{ name: "ready", facet: defineFacet((facet) => {
			facet.serve(item, () => ({ value: constant(4) }));
			facet.serve(registry, { compose: (entries) => entries.map(({ value }) => value) });
		}) }], context);
		const ref = await host.get(item, {}, context);
		expect(ref.value.value).toBe(4);
		ref.release();
		expect((await host.registry(registry, context)).value).toEqual([]);
	} finally { await host.close(context); }
});

it("answers before startup and parents handler spans under HTTP without recording path secrets", async () => {
	const telemetry = new InMemoryTelemetryContext();
	const host = createHost({ onError() {} });
	const http = createHttp(host, { telemetry, onError() {} }, context);
	const connection = { localAddress: "127.0.0.1", localPort: 7041, remoteAddress: "127.0.0.2" };
	const request = () => new Request("http://localhost:7041/entry/private-value", { headers: { host: "localhost:7041" } });
	try {
		expect((await http.fetch(request(), connection)).status).toBe(503);
		await host.load([
			{ name: "http", facet: http.facet },
			{ name: "routes", facet: defineFacet((_facet, self) => self.contribute(Http, { routes: {
				"GET /entry/:id": { public: true, handler: (request, ctx) => ctx.trace("request.lookup", {}, async (child) => {
					expect(child.principal).toBe(ctx.principal);
					expect(child.incarnation).toBe(ctx.incarnation);
					return { kind: "json", value: request.remoteAddress ?? null };
				}) },
			} })) },
		], context);
		expect(await (await http.fetch(request(), connection)).json()).toBe("127.0.0.2");
	} finally { await http.close(context); await host.close(context); }
	const spans = telemetry.getSpans();
	const httpSpan = spans.find(({ name }) => name === "objects.http")!;
	expect(httpSpan.attributes).toMatchObject({ route: "GET /entry/:id", status: 200 });
	expect(spans.find(({ name }) => name === "request.lookup")?.parentId).toBe(httpSpan.id);
	expect(JSON.stringify(spans)).not.toContain("private-value");
});

it("publishes bounded live rows in the same committed state and preserves them across reload", async () => {
	const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context);
	const host = createHost({ store, onError() {} });
	const table = defineTable("recent", { version: 1, columns: { id: str(), score: int() }, key: ["id"] });
	const item = local("recent", { version: 1, params: {}, members: {
		rows: arr(obj({ id: str(), score: int() })), put: method(obj({ id: str(), score: int() })),
	} });
	const facet = () => defineFacet((facet) => facet.serve(item, (_params, self: StoreSelf) => {
		const handle = self.table(table);
		return { rows: self.query(handle, query(table).orderBy((row) => row.score, "desc"), 2), put: async (row, ctx) => {
			await self.tx((tx) => tx.put(handle, row), ctx);
			return null;
		} };
	}));
	try {
		await host.load([{ name: "recent", facet: facet() }], context);
		const ref = await host.get(item, {}, context);
		expect(ref.rows.value).toEqual([]);
		for (const [id, score] of [["a", 1], ["b", 3], ["c", 2]] as const) await ref.put({ id, score }, context);
		expect(ref.rows.value).toEqual([{ id: "b", score: 3 }, { id: "c", score: 2 }]);
		await host.reload([{ name: "recent", facet: facet() }], context);
		expect(ref.rows.value).toEqual([{ id: "b", score: 3 }, { id: "c", score: 2 }]);
		ref.release();
	} finally { await host.close(context); await store.close(context); }
});

it.skipIf(process.platform === "win32")("clears only an unheld file lock and leaves a live holder intact", async () => {
	const directory = await mkdtemp(join(tmpdir(), "axi-lock-"));
	const lock = { kind: "file", address: join(directory, "worker.sock") } as const;
	try {
		await writeFile(lock.address, "stale");
		expect(await clearStaleLockAt(lock, context)).toBe(true);
		const held = await lockAt(lock, context);
		try { expect(await clearStaleLockAt(lock, context)).toBe(false); }
		finally { await held.release(); }
		expect(await clearStaleLockAt(lock, context)).toBe(false);
	} finally { await rm(directory, { recursive: true, force: true }); }
});

it("process locks exclude a second holder and cancellation leaves the live holder usable", async () => {
	const name = `axi-native-lock-${process.pid}`;
	const held = await processLock(name, context);
	const controller = new AbortController();
	const reason = new Error("lock acquisition cancelled");
	const waiting = processLock(name, withAbortSignal(controller.signal, context));
	const rejected = expect(waiting).rejects.toBe(reason);
	controller.abort(reason);
	await rejected;
	await held.release();
	const next = await processLock(name, context);
	await next.release();
});
