import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import * as api from "../src/index.ts";
import { ObjectsError } from "../src/data/index.ts";
import { Files, startServer, type App } from "../src/node/app/index.ts";
import { workerDirectory } from "../src/node/app/layout.ts";
import { openNodeSqliteDatabase } from "../src/sqlite/node.ts";

type Principal = { readonly kind: "owner" | "server" | "worker" };
const Notebook = api.hostKind("notebook", { name: api.str() });
const Metadata = api.local("test.archive-metadata", {
	version: 1,
	params: {},
	members: {
		set: api.method(api.obj({ name: api.str(), text: api.str() })),
		get: api.method(api.str(), api.obj({ text: api.str(), labels: api.arr(api.str()) })),
	},
});
const Notes = api.remote("test.archive-notes", {
	version: 1,
	params: { name: api.str() },
	hostAddress: ({ name }) => Notebook({ name }),
	variants: {
		main: {
			state: { body: api.str() },
			methods: {
				write: api.method(api.str()),
				attach: api.method(api.str(), api.str()),
				file: api.method(api.str(), api.str()),
			},
		},
	},
});
const plugin = `import { arr, defineFacet, defineState, defineTable, eq, host, hostKind, local, method, obj, query, str } from "@example/api/v1";
const Notebook = hostKind("notebook", { name: str() });
const State = defineState("metadata", { schema: obj({ text: str() }), version: 1, keyed: Notebook, persist: true, checkpointWhen: () => false, initial: () => ({ text: "" }) });
const Labels = defineTable("labels", { version: 1, columns: { notebook: host(Notebook), label: str() }, key: ["notebook", "label"] });
const Metadata = local("test.archive-metadata", { version: 1, params: {}, members: { set: method(obj({ name: str(), text: str() })), get: method(str(), obj({ text: str(), labels: arr(str()) })) } });
export default defineFacet((facet) => facet.serve(Metadata, (_, self) => {
	const state = self.state(State), labels = self.table(Labels);
	return {
		set: async ({ name, text }, ctx) => { await self.tx(async (tx) => { (await tx.draft(state, Notebook({ name }))).text = text; tx.put(labels, { notebook: Notebook({ name }), label: text }); }, ctx); return null; },
		get: async (name, ctx) => ({ text: (await state.get(Notebook({ name }), ctx))?.text ?? "", labels: (await labels.page(query(Labels).where((row) => eq(row.notebook, Notebook({ name }))), 10, ctx)).items.map((row) => row.label) }),
	};
}));`;
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "axi-archive-transaction-")),
		root = join(directory, "plugins"),
		folder = join(root, "metadata");
	cleanup.push(() => rm(directory, { recursive: true, force: true }));
	await mkdir(folder, { recursive: true });
	await writeFile(join(folder, "package.json"), JSON.stringify({ name: "metadata", type: "module" }));
	await writeFile(join(folder, "server.ts"), plugin);
	await writeFile(
		join(folder, "worker.ts"),
		`import { defineFacet, defineState, Files, hostKind, local, method, obj, remote, str } from "@example/api/v1";
const Notebook = hostKind("notebook", { name: str() });
const Notes = remote("test.archive-notes", { version: 1, params: { name: str() }, hostAddress: ({ name }) => Notebook({ name }), variants: { main: { state: { body: str() }, methods: { write: method(str()), attach: method(str(), str()), file: method(str(), str()) } } } });
const State = defineState("body", { schema: obj({ text: str() }), version: 1, persist: true, checkpointWhen: () => false, initial: () => ({ text: "" }) });
const Body = local("test.archive-body", { version: 1, params: {}, members: { body: str(), write: method(str()) } });
export default defineFacet((facet) => {
	facet.serve(Body, (_, self) => {
		const state = self.state(State);
		return { body: self.derive([state], ([value]) => value.text), write: async (text, ctx) => { await state.change((value) => { value.text = text; }, ctx); return null; } };
	});
	facet.serve(Notes, (_, _principal, self) => {
	const body = self.get(Body, {}), files = self.get(Files, {});
	return { variant: "main", members: {
		body: body.body,
		write: (text, ctx) => body.write(text, ctx),
		attach: async (text, ctx) => (await files.put({ space: "notes", path: "note.txt", mime: "text/plain", source: "test", bytes: new TextEncoder().encode(text) }, ctx)).id,
		file: async (id, ctx) => new TextDecoder().decode(await files.read({ id, offset: 0, length: 1024 }, ctx)),
	} };
	});
});`,
	);
	const app = await startServer<Principal>(
		{
			name: "archive-transactions",
			root,
			dataDir: join(directory, "data"),
			api: { name: "@example/api", versions: ["v1"], modules: { "@example/api/v1": { ...api, Files } } },
			kinds: { server: { platform: "node" }, worker: { platform: "node" } },
			workers: [
				{
					kind: Notebook,
					entry: fileURLToPath(new URL("./fixtures/app-worker.ts", import.meta.url)),
					authorize: () => true,
					start: () => null,
				},
			],
			principal: { server: { kind: "server" }, owner: { kind: "owner" }, worker: () => ({ kind: "worker" }) },
			onError() {},
		},
		context,
	);
	cleanup.push(() => app.close(context));
	return { app, directory, metadata: await app.host.get(Metadata, {}, context) };
}
async function workerFile(app: App<Principal>, name: string, text: string): Promise<string> {
	const dir = workerDirectory(app.dataDir, Notebook({ name }));
	await mkdir(join(dir, "files"), { recursive: true });
	await (
		await api.openStore(api.sqliteBackend(await openNodeSqliteDatabase(join(dir, "store.sqlite"))), context)
	).close(context);
	await writeFile(join(dir, "files", "note.txt"), text);
	return dir;
}

it("copies and deletes server documents and rows together with the worker's files", async () => {
	const f = await fixture(),
		source = Notebook({ name: "source" }),
		target = Notebook({ name: "copy" }),
		archive = join(f.directory, "data.tar");
	await workerFile(f.app, "source", "source file");
	await f.metadata.set({ name: "source", text: "source metadata" }, context);
	await f.app.exportData(source, archive, context);
	await f.app.importData(archive, target, context);
	expect(await f.metadata.get("copy", context)).toEqual({ text: "source metadata", labels: ["source metadata"] });
	expect(await readFile(join(workerDirectory(f.app.dataDir, target), "files", "note.txt"), "utf8")).toBe("source file");
	await f.metadata.set({ name: "server-only", text: "retained" }, context);
	await expect(f.app.importData(archive, Notebook({ name: "server-only" }), context)).rejects.toThrow(
		"has data in this store",
	);
	await expect(stat(workerDirectory(f.app.dataDir, Notebook({ name: "server-only" })))).rejects.toMatchObject({
		code: "ENOENT",
	});
	expect(await f.metadata.get("server-only", context)).toEqual({ text: "retained", labels: ["retained"] });
	await f.app.deleteData(target, context);
	expect(await f.metadata.get("copy", context)).toEqual({ text: "", labels: [] });
	expect(await f.metadata.get("source", context)).toEqual({ text: "source metadata", labels: ["source metadata"] });
});

it("exports from a running worker and reopens its documents and indexed files under a new address", async () => {
	const f = await fixture(),
		source = Notebook({ name: "running" }),
		target = Notebook({ name: "restored" }),
		archive = join(f.directory, "live.tar");
	const notes = await f.app.host.get(Notes, { name: "running" }, context);
	await notes.write("saved body", context);
	const file = await notes.attach("saved indexed file", context);
	notes.release();
	await f.metadata.set({ name: "running", text: "server metadata" }, context);
	await f.app.exportData(source, archive, context);
	await f.app.importData(archive, target, context);
	const copy = await f.app.host.get(Notes, { name: "restored" }, context);
	expect(copy.body.value).toBe("saved body");
	expect(await copy.file(file, context)).toBe("saved indexed file");
	expect(await f.metadata.get("restored", context)).toEqual({ text: "server metadata", labels: ["server metadata"] });
	copy.release();
	await expect(f.app.deleteData(target, context)).rejects.toThrow("stop its worker first");
	await f.app.workers.get(Notebook.kind)!.stop(target, context);
	await f.app.deleteData(target, context);
	expect(await f.metadata.get("restored", context)).toEqual({ text: "", labels: [] });
}, 30_000);

it("restores the old directory after a definite failure and retains both directories after an uncertain commit", async () => {
	const f = await fixture(),
		source = Notebook({ name: "source" }),
		target = Notebook({ name: "target" }),
		archive = join(f.directory, "data.tar");
	await workerFile(f.app, "source", "new file");
	const dir = await workerFile(f.app, "target", "old file");
	await f.app.exportData(source, archive, context);
	const importer = vi.spyOn(f.app.host, "importHostData");
	importer.mockRejectedValueOnce(new Error("definite refusal"));
	await expect(f.app.importData(archive, target, context, { existing: "replace" })).rejects.toThrow("definite refusal");
	expect(await readFile(join(dir, "files", "note.txt"), "utf8")).toBe("old file");
	importer.mockRejectedValueOnce(
		new ObjectsError({ code: "unavailable", reason: "storage_failed", message: "uncertain commit" }),
	);
	await expect(f.app.importData(archive, target, context, { existing: "replace" })).rejects.toThrow(
		"nothing was undone",
	);
	expect(await readFile(join(dir, "files", "note.txt"), "utf8")).toBe("new file");
	const parent = join(f.app.dataDir, "workers", target.kind),
		aside = (await readdir(parent)).find((name) => name.includes(".aside-"));
	expect(aside).toBeDefined();
	expect(await readFile(join(parent, aside!, "files", "note.txt"), "utf8")).toBe("old file");
	importer.mockRestore();
	const deleter = vi.spyOn(f.app.host, "deleteHostData").mockRejectedValueOnce(new Error("delete refused"));
	await expect(f.app.deleteData(target, context)).rejects.toThrow("delete refused");
	expect((await stat(dir)).isDirectory()).toBe(true);
	deleter.mockRestore();
	await f.app.deleteData(target, context);
	await expect(stat(dir)).rejects.toMatchObject({ code: "ENOENT" });
});
