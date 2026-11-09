import { mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Context } from "../../context/index.ts";
import { openNodeSqliteDatabase } from "../../sqlite/node.ts";
import { type ArchivePart, importStore, type Store, sqliteBackend } from "../../store/index.ts";
import { Blobs } from "./blobs.ts";
import { Files } from "./files.ts";
import { privateDirectory, privateStore } from "./layout.ts";

export async function copyFiles(
	source: { readonly store: Store; readonly files: string },
	target: string,
	context: Context,
): Promise<void> {
	if (
		await stat(target).then(
			() => true,
			() => false,
		)
	)
		throw new Error(`copyFiles: ${target} exists already`);
	const parent = dirname(target);
	await privateDirectory(parent);
	const staging = await mkdtemp(join(parent, ".objects-files-copy-"));
	try {
		const blobs = new Blobs(join(source.files, "blobs"));
		const destination = join(staging, "files", "blobs");
		await mkdir(destination, { recursive: true, mode: 0o700 });
		const path = join(staging, "store.sqlite");
		await privateStore(path);
		const backend = sqliteBackend(await openNodeSqliteDatabase(path));
		const store = await importStore(backend, fileParts(source.store, blobs, destination, context), context);
		await store.close(context);
		await rename(staging, target);
	} catch (error) {
		await rm(staging, { force: true, recursive: true });
		throw error;
	}
}

async function* fileParts(
	store: Store,
	blobs: Blobs,
	destination: string,
	context: Context,
): AsyncGenerator<ArchivePart> {
	const documents = new Set<number>();
	let writes = 0;
	for await (const part of store.export(context)) {
		let include = false;
		switch (part.kind) {
			case "manifest":
				include = true;
				break;
			case "table":
			case "put":
			case "index":
				include = part.table.startsWith(Files.name + ":");
				break;
			case "document.create":
				include = part.record.owner === Files.name;
				if (include) documents.add(part.record.id);
				break;
			case "document.revision":
				include = documents.has(part.id);
				break;
			case "end":
				yield { kind: "end", writes };
				break;
		}
		if (!include) continue;
		if (part.kind === "put" && part.table === Files.name + ":blobs")
			await blobs.linkInto(part.row.id as string, destination);
		if (part.kind !== "manifest") writes++;
		yield part;
	}
}
