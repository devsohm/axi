import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import { local, method, obj, str } from "../src/contracts/index.ts";
import { defineState } from "../src/documents/index.ts";
import { createHost, defineFacet } from "../src/host/index.ts";
import { copyFiles, Files, FilesFolder, filesFacet, type FilesCaps } from "../src/node/app/files-entry.ts";
import { openNodeSqliteDatabase } from "../src/sqlite/node.ts";
import { openStore, sqliteBackend } from "../src/store/index.ts";

let directory: string;
const cleanup: (() => Promise<void>)[] = [];
const encode = new TextEncoder();
const Extra = local("files-test.extra", { version: 1, params: {}, members: { write: method(str()) } });
const Saved = defineState("saved", {
	version: 1,
	schema: obj({ text: str() }),
	persist: true,
	initial: () => ({ text: "" }),
	checkpointWhen: () => false,
});
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "axi-files-"));
});
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
	await rm(directory, { force: true, recursive: true });
});
async function openFiles(path = join(directory, "host"), caps: FilesCaps = {}) {
	const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(join(path, "store.sqlite"))), context);
	const errors: unknown[] = [];
	const host = createHost({ store, onError: (error) => errors.push(error) });
	await host.load(
		[
			{ name: Files.name, facet: filesFacet(join(path, "files"), caps) },
			{
				name: "extra",
				facet: defineFacet((h) =>
					h.serve(Extra, (_, self) => {
						const saved = self.state(Saved);
						return {
							write: (text, ctx) =>
								self.tx(async (tx) => {
									(await tx.draft(saved)).text = text;
									return null;
								}, ctx),
						};
					}),
				),
			},
		],
		context,
	);
	const files = await host.get(Files, {}, context);
	let closed = false;
	async function close() {
		if (closed) return;
		closed = true;
		files.release();
		await host.close(context);
		await store.close(context);
		expect(errors).toEqual([]);
	}
	cleanup.push(close);
	return { store, host, files, close, path };
}
const write = (path: string, body: string, space = "work") => ({
	space,
	path,
	source: "test",
	mime: "text/plain",
	bytes: encode.encode(body),
});

it("retains version counters through deletion, relocation, space removal and SQLite restart", async () => {
	const first = await openFiles();
	const one = await first.files.put(write("notes/a", "one"), context);
	const two = await first.files.put(write("notes/a", "two"), context);
	expect([one.version, two.version]).toEqual([1, 2]);
	await first.files.remove(two.id, context);
	expect((await first.files.get({ space: "work", path: "notes/a" }, context))?.id).toBe(one.id);
	await first.files.removePath({ space: "work", path: "notes/a" }, context);
	expect((await first.files.put(write("notes/a", "three"), context)).version).toBe(3);
	await first.files.move({ space: "work", from: "notes/a", to: "notes/b" }, context);
	expect((await first.files.put(write("notes/b", "four"), context)).version).toBe(4);
	await first.files.removeSpace("work", context);
	expect(await first.files.summary.get("work", context)).toBeUndefined();
	const saved = await first.files.put(write("notes/b", "five"), context);
	expect(saved.version).toBe(5);
	await first.close();
	const reopened = await openFiles();
	expect(await reopened.files.get({ space: "work", path: "notes/b" }, context)).toEqual(saved);
	expect(await reopened.files.read({ id: saved.id, offset: 0, length: 10 }, context)).toEqual(encode.encode("five"));
	expect(await reopened.files.summary.get("work", context)).toMatchObject({ files: 1, versions: 1, bytes: 4 });
});

it("deduplicates delivery keys and shares blobs until the last version releases them", async () => {
	const { files, path } = await openFiles(undefined, { maxFile: 4, maxTotal: 4 });
	const original = await files.put({ ...write("item", "data"), key: "delivery", meta: { title: "item" } }, context);
	expect(await files.put({ ...write("ignored", "else"), key: "delivery" }, context)).toEqual(original);
	const copied = await files.copy({ id: original.id, space: "other", path: "copy" }, context);
	expect(copied).toMatchObject({ size: 4, meta: { title: "item" } });
	expect(copied).not.toHaveProperty("key");
	expect(await readdir(join(path, "files", "blobs"))).toHaveLength(1);
	await files.remove(original.id, context);
	expect(await files.read({ id: copied.id, offset: 0, length: 4 }, context)).toEqual(encode.encode("data"));
	await expect(files.put(write("full", "x"), context)).rejects.toMatchObject({ code: "too_large" });
	await files.remove(copied.id, context);
	expect(await readdir(join(path, "files", "blobs"))).toEqual([]);
	expect((await files.put(write("room", "new!"), context)).size).toBe(4);
});

it("orders the twenty newest versions by timestamp and descending ID even when timestamps tie", async () => {
	const { files } = await openFiles();
	const versions = [];
	for (let index = 0; index < 25; index++)
		versions.push(await files.put({ ...write(`f${index}`, "x"), created: index < 22 ? index : 100 }, context));
	versions.sort((left, right) => right.created - left.created || (left.id < right.id ? 1 : -1));
	expect((await files.summary.get("work", context))?.newest).toEqual(versions.slice(0, 20));
	await files.remove(versions[0]!.id, context);
	expect((await files.summary.get("work", context))?.newest).toEqual(versions.slice(1, 21));
});

it("pages folders before current files and updates live views after moves and removals", async () => {
	const { files, host } = await openFiles();
	const view = await host.get(FilesFolder, { space: "work", folder: "" }, context);
	try {
		await files.mkdir({ space: "work", path: "z/sub" }, context);
		await files.mkdir({ space: "work", path: "a" }, context);
		await files.put(write("b", "old"), context);
		const current = await files.put(write("b", "new"), context);
		const entries = [];
		let after: string | undefined;
		do {
			const page = await files.list({ space: "work", folder: "", limit: 1, ...(after ? { after } : {}) }, context);
			entries.push(...page.items);
			after = page.next;
		} while (after !== undefined);
		expect(entries.map((entry) => entry.kind)).toEqual(["folder", "folder", "file"]);
		expect(entries[2]).toEqual({ kind: "file", file: current });
		expect(view.listing.value).toEqual({ entries, more: false });
		await files.move({ space: "work", from: "z", to: "moved" }, context);
		expect(view.listing.value.entries).toContainEqual({
			kind: "folder",
			folder: expect.objectContaining({ path: "moved" }),
		});
		await files.removePath({ space: "work", path: "moved" }, context);
		expect(view.listing.value.entries).toHaveLength(2);
		await expect(files.put(write("a/../bad", "x"), context)).rejects.toMatchObject({ code: "invalid" });
		await expect(files.put(write("a", "x"), context)).rejects.toMatchObject({
			code: "invalid",
			details: { conflict: "a" },
		});
		await expect(files.list({ space: "work", folder: "", after: "bad cursor" }, context)).rejects.toMatchObject({
			code: "invalid",
		});
	} finally {
		view.release();
	}
});

it("resumes keyed uploads, checks offsets and releases cancelled or committed uploads", async () => {
	const { files } = await openFiles();
	const data = { space: "work", path: "chunked", source: "test", mime: "text/plain", key: "upload" };
	const begun = await files.begin(data, context);
	if (begun.kind !== "upload") throw new Error("expected a new upload");
	expect(await files.begin(data, context)).toEqual(begun);
	const { upload } = begun;
	await Promise.all([
		files.append({ upload, offset: 0, bytes: encode.encode("ab") }, context),
		files.append({ upload, offset: 2, bytes: encode.encode("cd") }, context),
	]);
	await expect(files.append({ upload, offset: 1, bytes: encode.encode("x") }, context)).rejects.toMatchObject({
		code: "invalid",
	});
	expect(await files.uploaded(upload, context)).toBe(4);
	const committed = await files.finish(upload, context);
	expect(await files.begin(data, context)).toEqual({ kind: "exists", file: committed });
	await expect(files.uploaded(upload, context)).rejects.toMatchObject({ code: "invalid" });
	const discarded = await files.begin({ ...data, key: "cancel" }, context);
	if (discarded.kind !== "upload") throw new Error("expected a new upload");
	await files.cancel(discarded.upload, context);
	await files.cancel(discarded.upload, context);
	await expect(files.finish(discarded.upload, context)).rejects.toMatchObject({ code: "invalid" });
});

it("copies only the file index and committed blobs into an independently writable host", async () => {
	const source = await openFiles();
	const extra = await source.host.get(Extra, {}, context);
	await extra.write("unrelated saved data", context);
	extra.release();
	const original = await source.files.put(write("docs/item", "content"), context);
	await source.files.begin({ space: "work", path: "incomplete", source: "test", mime: "text/plain" }, context);
	const target = join(directory, "copy");
	await copyFiles({ store: source.store, files: join(source.path, "files") }, target, context);
	const exported = await openStore(sqliteBackend(await openNodeSqliteDatabase(join(target, "store.sqlite"))), context);
	for await (const part of exported.export(context)) {
		if (part.kind === "document.create") expect(part.record.owner).toBe(Files.name);
		if (part.kind === "table") expect(part.table.startsWith(Files.name + ":")).toBe(true);
	}
	await exported.close(context);
	const copied = await openFiles(target);
	expect(await copied.files.file(original.id, context)).toEqual(original);
	expect(await copied.files.read({ id: original.id, offset: 0, length: 10 }, context)).toEqual(
		encode.encode("content"),
	);
	await source.files.removeSpace("work", context);
	expect(await copied.files.file(original.id, context)).toEqual(original);
	expect((await copied.files.put(write("docs/item", "changed"), context)).version).toBe(2);
	await expect(copyFiles({ store: source.store, files: join(source.path, "files") }, target, context)).rejects.toThrow(
		"exists",
	);
});
