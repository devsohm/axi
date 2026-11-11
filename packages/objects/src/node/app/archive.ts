import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, open, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Context } from "../../context/index.ts";
import { openNodeSqliteDatabase } from "../../sqlite/node.ts";
import { decodeJsonl, encodeJsonl, importStore, openStore, sqliteBackend, type Store } from "../../store/index.ts";
import { privateDirectory, privateStore } from "./layout.ts";
import { readTar, writeTar, type TarEntry } from "./tar.ts";
export const ARCHIVE_FORMAT = 2;
export type ArchiveManifest = {
	readonly format: number;
	readonly app: string;
	readonly api: string;
	readonly address: { readonly kind: string; readonly key: string };
};
export type ImportLimits = { readonly bytes?: number; readonly entries?: number };
export async function exists(path: string): Promise<boolean> {
	return stat(path).then(
		() => true,
		() => false,
	);
}
async function* once(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
	yield bytes;
}
async function* walk(dir: string): AsyncGenerator<string> {
	const entries = await readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return [];
		throw error;
	});
	for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
		if (entry.name.startsWith(".")) continue;
		const path = join(dir, entry.name);
		if (entry.isDirectory()) yield* walk(path);
		else if (entry.isFile()) yield path;
	}
}
async function* fileEntries(root: string): AsyncGenerator<TarEntry> {
	for await (const path of walk(root)) {
		const handle = await open(path, "r").catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return undefined;
			throw error;
		});
		if (!handle) continue;
		const info = await handle.stat();
		if (!info.isFile()) {
			await handle.close();
			continue;
		}
		yield {
			path: "files/" + relative(root, path).split(sep).join("/"),
			size: info.size,
			data: handle.createReadStream({ start: 0, end: Math.max(0, info.size - 1) }),
		};
	}
}
export async function packData(
	dir: string,
	manifest: ArchiveManifest,
	server: string,
	path: string,
	context: Context,
): Promise<void> {
	if (!(await exists(dir))) throw new Error(`exportData: ${manifest.address.key} has no data`);
	const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(join(dir, "store.sqlite"))), context);
	try {
		await packStore(store, join(dir, "files"), manifest, server, path, context);
	} finally {
		await store.close(context);
	}
}
export async function packStore(
	store: Store,
	files: string,
	manifest: ArchiveManifest,
	server: string,
	path: string,
	context: Context,
): Promise<void> {
	const staging = await mkdtemp(join(dirname(path), ".objects-export-"));
	try {
		const exported = join(staging, "store.archive");
		await pipeline(encodeJsonl(store.export(context)), createWriteStream(exported, { mode: 0o600 }));
		const description = new TextEncoder().encode(JSON.stringify(manifest)),
			size = (await stat(exported)).size;
		async function* entries(): AsyncGenerator<TarEntry> {
			yield { path: "manifest.json", size: description.length, data: once(description) };
			yield { path: "store.archive", size, data: createReadStream(exported) };
			yield { path: "server.archive", size: (await stat(server)).size, data: createReadStream(server) };
			yield* fileEntries(files);
		}
		const target = join(staging, "archive.tar");
		await pipeline(writeTar(entries()), createWriteStream(target, { mode: 0o600 }));
		await rename(target, path);
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
}
export async function unpackStaging(
	archive: string,
	parent: string,
	accept: (manifest: ArchiveManifest) => void,
	limits: ImportLimits,
	context: Context,
): Promise<{ readonly staging: string; readonly server: string }> {
	await privateDirectory(parent);
	const staging = await mkdtemp(join(parent, ".objects-import-"));
	try {
		let manifest = false,
			storeArchive: string | undefined,
			serverArchive: string | undefined,
			count = 0,
			size = 0;
		for await (const entry of readTar(createReadStream(archive))) {
			context.abortSignal?.throwIfAborted();
			if (++count > (limits.entries ?? 100_000))
				throw new Error(`importData: the archive has more than ${limits.entries ?? 100_000} entries`);
			if (entry.kind === "directory") continue;
			size += entry.size;
			if (size > (limits.bytes ?? 4 * 1024 ** 3))
				throw new Error(`importData: the archive unpacks to more than ${limits.bytes ?? 4 * 1024 ** 3} bytes`);
			if (!manifest && entry.path !== "manifest.json")
				throw new Error("importData: the archive does not start with manifest.json");
			if (entry.path === "manifest.json") {
				const parts: Uint8Array[] = [];
				let length = 0;
				for await (const part of entry.data) {
					length += part.length;
					if (length > 65536) throw new Error("importData: manifest.json is too large");
					parts.push(part);
				}
				accept(JSON.parse(Buffer.concat(parts).toString("utf8")) as ArchiveManifest);
				manifest = true;
			} else if (entry.path === "store.archive" || entry.path === "server.archive" || entry.path.startsWith("files/")) {
				const target = join(staging, ...entry.path.split("/"));
				if (entry.path === "store.archive") storeArchive = target;
				if (entry.path === "server.archive") serverArchive = target;
				await mkdir(dirname(target), { recursive: true, mode: 0o700 });
				await pipeline(entry.data, createWriteStream(target, { mode: 0o600 }));
			} else throw new Error(`importData: the archive holds ${entry.path}, which an address archive does not`);
		}
		if (!manifest || !storeArchive || !serverArchive)
			throw new Error("importData: the archive has no manifest.json, store.archive or server.archive");
		const database = join(staging, "store.sqlite");
		await privateStore(database);
		const backend = sqliteBackend(await openNodeSqliteDatabase(database)),
			store = await importStore(backend, decodeJsonl(createReadStream(storeArchive)), context);
		await store.close(context);
		await rm(storeArchive);
		return { staging, server: serverArchive };
	} catch (error) {
		await rm(staging, { recursive: true, force: true });
		throw error;
	}
}
