import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import { createHost, encodeJsonl, openStore, sqliteBackend } from "../src/index.ts";
import { openNodeSqliteDatabase } from "../src/sqlite/node.ts";
import { ARCHIVE_FORMAT, packStore, unpackStaging, type ArchiveManifest } from "../src/node/app/archive.ts";
import { defineUsers } from "../src/node/app/users.ts";
import { obj, str } from "../src/contracts/index.ts";
import { readTar, writeTar } from "../src/node/app/tar.ts";

async function* chunks(bytes: Uint8Array, size = 7) {
	for (let offset = 0; offset < bytes.length; offset += size) yield bytes.subarray(offset, offset + size);
}
async function bytes(source: AsyncIterable<Uint8Array>) {
	const parts: Uint8Array[] = [];
	for await (const part of source) parts.push(part);
	return Buffer.concat(parts);
}

it("round-trips application rows, server data and finished files and removes an over-limit staging import", async () => {
	const dir = await mkdtemp(join(tmpdir(), "axi-app-archive-")),
		files = join(dir, "files"),
		archive = join(dir, "address.tar"),
		server = join(dir, "server.jsonl");
	const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(join(dir, "store.sqlite"))), context),
		host = createHost({ store, onError() {} });
	const users = defineUsers(obj({ name: str() })),
		manifest: ArchiveManifest = {
			format: ARCHIVE_FORMAT,
			app: "notes",
			api: "v1",
			address: { kind: "notebook", key: "notebook|one" },
		};
	try {
		await mkdir(files);
		await writeFile(join(files, "saved.txt"), "retained file");
		await writeFile(join(files, ".unfinished"), "not retained");
		await host.load([{ name: "users", facet: users.facet }], context);
		const accounts = await host.get(users.Users, {}, context);
		await accounts.update({ id: "user", profile: { name: "Ari" } }, context);
		accounts.release();
		await writeFile(server, await bytes(encodeJsonl(host.exportHostData({ ...manifest.address, params: { name: "one" } }, context))));
		await packStore(store, files, manifest, server, archive, context);
		await expect(unpackStaging(archive, dir, () => {}, { bytes: 1 }, context)).rejects.toThrow("more than 1 bytes");
		expect(await readdir(dir)).not.toContain("restored");
		expect((await readdir(dir)).some((name) => name.startsWith(".objects-import-"))).toBe(false);
		const { staging: target, server: serverPart } = await unpackStaging(archive, dir, (value) => expect(value).toEqual(manifest), {}, context);
		expect(await readFile(serverPart, "utf8")).toBe(await readFile(server, "utf8"));
		expect(await readdir(join(target, "files"))).toEqual(["saved.txt"]);
		expect(await readFile(join(target, "files/saved.txt"), "utf8")).toBe("retained file");
		expect((await stat(join(target, "store.sqlite"))).mode & 0o777).toBe(0o600);
		const reopened = await openStore(
				sqliteBackend(await openNodeSqliteDatabase(join(target, "store.sqlite"))),
				context,
			),
			reader = createHost({ store: reopened, onError() {} });
		try {
			await reader.load([{ name: "users", facet: users.facet }], context);
			const ref = await reader.get(users.Users, {}, context);
			expect(await ref.get("user", context)).toEqual({ name: "Ari" });
			ref.release();
		} finally {
			await reader.close(context);
			await reopened.close(context);
		}
	} finally {
		await host.close(context);
		await store.close(context);
		await rm(dir, { recursive: true, force: true });
	}
});

it("reads arbitrarily split tar frames and rejects path traversal, bad checksums and truncated payloads", async () => {
	const archive = await bytes(writeTar([{ path: "files/a.txt", size: 4, data: chunks(Buffer.from("data")) }])),
		entries = [];
	for await (const entry of readTar(chunks(archive))) {
		if (entry.kind === "file") entries.push([entry.path, (await bytes(entry.data)).toString()]);
	}
	expect(entries).toEqual([["files/a.txt", "data"]]);
	await expect(bytes(writeTar([{ path: "../escape", size: 0, data: chunks(new Uint8Array()) }]))).rejects.toThrow(
		"refused",
	);
	const corrupt = Buffer.from(archive);
	corrupt[0] = 0;
	await expect(
		(async () => {
			for await (const _entry of readTar(chunks(corrupt))) {
			}
		})(),
	).rejects.toThrow("checksum");
	await expect(
		(async () => {
			for await (const entry of readTar(chunks(archive.subarray(0, 514)))) {
				if (entry.kind === "file") await bytes(entry.data);
			}
		})(),
	).rejects.toThrow("ends inside");
});
