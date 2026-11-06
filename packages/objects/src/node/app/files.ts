import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Context } from "../../context/index.ts";
import {
	arr,
	bool,
	bytes,
	int,
	keyed,
	lit,
	local,
	method,
	nul,
	obj,
	opt,
	type TSchema,
	str,
	union,
} from "../../contracts/index.ts";
import { ObjectsError, type Principal } from "../../data/index.ts";
import { invalid } from "../../data/internal.ts";
import { type Ctx, defineFacet, type Facet } from "../../host/index.ts";
import { Blobs } from "./blobs.ts";
import {
	checkPath,
	checkSpace,
	type FileInfo,
	FileSchema,
	FilesIndex,
	type FileWrite,
	FolderSchema,
	MAX_PAGE,
	MetaSchema,
	SummarySchema,
} from "./files-index.ts";
import { type FolderListing, FolderViews } from "./folder-views.ts";
import { newToken } from "./secrets.ts";
import { Uploads } from "./uploads.ts";

export type { FileInfo, FileWrite, FolderEntry, FolderInfo, SpaceSummary } from "./files-index.ts";
export type { FolderListing } from "./folder-views.ts";
export type FilesCaps = { readonly maxFile?: number; readonly maxTotal?: number };
const writeFields = {
	space: str(),
	path: str(),
	mime: str(),
	source: str(),
	ref: opt(str({ min: 1 })),
	key: opt(str({ min: 1 })),
	meta: opt(MetaSchema),
	created: opt(int({ min: 0 })),
};
const pageFields = { after: opt(str()), limit: opt(int({ min: 1, max: MAX_PAGE })) };
const pageOf = <T extends TSchema>(schema: T) => obj({ items: arr(schema), next: opt(str()) });
const maybeFile = union([FileSchema, nul()]);
const entrySchema = union([
	obj({ kind: lit("folder"), folder: FolderSchema }),
	obj({ kind: lit("file"), file: FileSchema }),
]);
export const Files = local("objects.app.files", {
	version: 2,
	params: {},
	members: {
		summary: keyed(SummarySchema),
		put: method(obj({ ...writeFields, bytes: bytes() }), FileSchema),
		begin: method(
			obj(writeFields),
			union([obj({ kind: lit("upload"), upload: str() }), obj({ kind: lit("exists"), file: FileSchema })]),
		),
		append: method(obj({ upload: str(), offset: int({ min: 0 }), bytes: bytes() })),
		uploaded: method(str(), int()),
		finish: method(str(), FileSchema),
		cancel: method(str()),
		read: method(obj({ id: str(), offset: int({ min: 0 }), length: int({ min: 0 }) }), bytes()),
		file: method(str(), maybeFile),
		get: method(obj({ space: str(), path: str(), version: opt(int({ min: 1 })) }), maybeFile),
		byKey: method(obj({ space: str(), key: str({ min: 1 }) }), maybeFile),
		byRef: method(obj({ space: str(), ref: str({ min: 1 }), ...pageFields }), pageOf(FileSchema)),
		versions: method(obj({ space: str(), path: str(), ...pageFields }), pageOf(FileSchema)),
		list: method(obj({ space: str(), folder: str(), ...pageFields }), pageOf(entrySchema)),
		mkdir: method(obj({ space: str(), path: str() }), FolderSchema),
		move: method(obj({ space: str(), from: str(), to: str() })),
		copy: method(obj({ id: str(), space: str(), path: str() }), FileSchema),
		remove: method(str()),
		removePath: method(obj({ space: str(), path: str() })),
		removeSpace: method(str()),
	},
});
export const FilesFolder = local("objects.app.files.folder", {
	version: 1,
	params: { space: str(), folder: str() },
	members: { listing: obj({ entries: arr(entrySchema), more: bool() }) },
});
const piece = 4 * 1024 * 1024;
const tooLarge = (message: string) => new ObjectsError({ code: "too_large", message: "files: " + message });
function checkWrite(write: FileWrite): void {
	checkSpace(write.space);
	checkPath(write.path, "file");
}

export function filesFacet<P extends Principal>(dir: string, caps: FilesCaps = {}, uploads = 64): Facet<P> {
	const blobs = new Blobs(join(dir, "blobs"));
	const views = new FolderViews();
	const uploadsDir = join(dir, ".uploads");
	const maxFile = caps.maxFile ?? 256 * 1024 * 1024;
	const maxTotal = caps.maxTotal ?? 4 * 1024 ** 3;
	return defineFacet<P>((host) => {
		host.serve(Files, (_params, self) => {
			const index = new FilesIndex(self);
			const run = join(uploadsDir, newToken(12));
			const pending = new Uploads<FileWrite>(run, uploads);
			let queue: Promise<unknown> = Promise.resolve();
			const change = <T>(operation: () => Promise<T>): Promise<T> => {
				const next = queue.then(operation);
				queue = next.catch(() => {});
				return next;
			};
			views.bind(async (space, folder, context) => {
				const page = await index.list(space, folder, 500, undefined, context);
				return { entries: page.items, more: page.next !== undefined };
			});
			const room = (adding: number, size: number): void => {
				if (size > maxFile) throw tooLarge(`a file of ${size} bytes is larger than this host's cap (${maxFile})`);
				if (index.usage.value.bytes + pending.size + adding > maxTotal)
					throw tooLarge(`this host's files would exceed their cap (${maxTotal} bytes)`);
			};
			const existing = (write: FileWrite, context: Ctx): Promise<FileInfo | undefined> =>
				write.key === undefined ? Promise.resolve(undefined) : index.byKey(write.space, write.key, context);
			const commit = async (write: FileWrite, blob: string, size: number, context: Ctx): Promise<FileInfo> => {
				try {
					const file = await index.add(newToken(12), write, { id: blob, size, fresh: true }, context);
					await views.changed(write.space, context);
					return file;
				} catch (error) {
					await blobs.remove([blob]);
					throw error;
				}
			};
			self.onLive((context) =>
				sweep(uploadsDir, run, pending, () => change(() => blobs.sweep((id) => index.hasBlob(id, context))), context),
			);
			return {
				summary: index.summary,
				put: ({ bytes, ...write }, context) => {
					checkWrite(write);
					if (bytes.length > piece) throw tooLarge(`put takes at most ${piece} bytes: use begin, append, finish`);
					return change(async () => {
						const known = await existing(write, context);
						if (known) return known;
						room(bytes.length, bytes.length);
						const blob = newToken(12),
							staging = join(run, `put-${blob}`);
						try {
							await blobs.write(blob, bytes, staging);
						} catch (error) {
							await rm(staging, { force: true });
							throw error;
						}
						return commit(write, blob, bytes.length, context);
					});
				},
				begin: (write, context) => {
					checkWrite(write);
					return change(async () => {
						const known = await existing(write, context);
						if (known) return { kind: "exists" as const, file: known };
						const resumed = pending.find(
							(data) => data.space === write.space && data.key !== undefined && data.key === write.key,
						);
						if (resumed !== undefined) return { kind: "upload" as const, upload: resumed };
						if ((await index.exists(write.space, write.path, context)) === "folder")
							throw invalid("args", `files: ${write.space}:${write.path} is a folder`, { conflict: write.path });
						return { kind: "upload" as const, upload: await pending.begin(write) };
					});
				},
				append: async ({ upload, offset, bytes }) => {
					if (bytes.length > piece) throw tooLarge(`append takes at most ${piece} bytes`);
					await pending.append(upload, offset, bytes, room);
					return null;
				},
				uploaded: (upload) => pending.uploaded(upload),
				finish: (upload, context) =>
					change(async () => {
						const blob = newToken(12);
						await blobs.prepare();
						const { data, size } = await pending.finish(upload, blobs.path(blob));
						const known = await existing(data, context);
						if (!known) return commit(data, blob, size, context);
						await blobs.remove([blob]);
						return known;
					}),
				cancel: async (upload) => {
					await pending.cancel(upload);
					return null;
				},
				read: async ({ id, offset, length }, context) => {
					if (length > piece) throw tooLarge(`read takes at most ${piece} bytes`);
					const entry = await index.blobOf(id, context);
					if (!entry) throw invalid("args", `files: no file ${id}`);
					return blobs.read(entry.blob, entry.size, offset, length);
				},
				file: async (id, context) => (await index.file(id, context)) ?? null,
				get: async ({ space, path, version }, context) => {
					checkSpace(space);
					checkPath(path, "file");
					return (await index.get(space, path, version, context)) ?? null;
				},
				byKey: async ({ space, key }, context) => {
					checkSpace(space);
					return (await index.byKey(space, key, context)) ?? null;
				},
				byRef: ({ space, ref, limit, after }, context) => {
					checkSpace(space);
					return index.byRef(space, ref, limit ?? 100, after, context);
				},
				versions: ({ space, path, limit, after }, context) => {
					checkSpace(space);
					checkPath(path, "file");
					return index.versions(space, path, limit ?? 100, after, context);
				},
				list: ({ space, folder, limit, after }, context) => {
					checkSpace(space);
					checkPath(folder, "folder");
					return index.list(space, folder, limit ?? 100, after, context);
				},
				mkdir: ({ space, path }, context) => {
					checkSpace(space);
					checkPath(path, "file");
					return change(async () => {
						const folder = await index.mkdir(space, path, context);
						await views.changed(space, context);
						return folder;
					});
				},
				move: ({ space, from, to }, context) => {
					checkSpace(space);
					checkPath(from, "file");
					checkPath(to, "file");
					return change(async () => {
						await index.move(space, from, to, context);
						await views.changed(space, context);
						return null;
					});
				},
				copy: ({ id, space, path }, context) => {
					checkSpace(space);
					checkPath(path, "file");
					return change(async () => {
						const file = await index.file(id, context),
							blob = await index.blobOf(id, context);
						if (!file || !blob) throw invalid("args", `files: no file ${id}`);
						const { mime, source, ref, meta } = file;
						const copied = await index.add(
							newToken(12),
							{
								space,
								path,
								mime,
								source,
								...(ref === undefined ? {} : { ref }),
								...(meta === undefined ? {} : { meta }),
							},
							{ id: blob.blob, size: blob.size, fresh: false },
							context,
						);
						await views.changed(space, context);
						return copied;
					});
				},
				remove: (id, context) =>
					change(async () => {
						const removed = await index.remove(id, context);
						if (removed) {
							await blobs.remove(removed.gone);
							await views.changed(removed.space, context);
						}
						return null;
					}),
				removePath: ({ space, path }, context) => {
					checkSpace(space);
					checkPath(path, "file");
					return change(async () => {
						await blobs.remove(await index.removePath(space, path, context));
						await views.changed(space, context);
						return null;
					});
				},
				removeSpace: (space, context) => {
					checkSpace(space);
					return change(async () => {
						await blobs.remove(await index.removeSpace(space, context));
						await views.changed(space, context);
						return null;
					});
				},
			};
		});
		host.serve(FilesFolder, ({ space, folder }, self) => {
			checkSpace(space);
			checkPath(folder, "folder");
			self.get(Files, {});
			return {
				listing: self.follow<FolderListing>((observer, context) => views.attach(space, folder, observer, context)),
			};
		});
	});
}

async function sweep(
	directory: string,
	run: string,
	pending: Uploads<FileWrite>,
	cleanBlobs: () => Promise<void>,
	context: Context,
): Promise<void> {
	for (const child of await readdir(directory).catch(() => []))
		if (join(directory, child) !== run) await rm(join(directory, child), { recursive: true, force: true });
	try {
		await cleanBlobs();
		for (;;) {
			await delay(60_000, undefined, { signal: context.abortSignal });
			await pending.expire(60 * 60_000);
		}
	} finally {
		if (context.abortSignal?.aborted) await pending.close();
	}
}
