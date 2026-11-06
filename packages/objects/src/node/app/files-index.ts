import { randomUUID } from "node:crypto";
import type { TUnsafe } from "typebox";
import type { Context } from "../../context/index.ts";
import { arr, int, obj, opt, str, type TSchema, unknown } from "../../contracts/index.ts";
import type { Principal } from "../../data/index.ts";
import { invalid } from "../../data/internal.ts";
import { defineState, type KeyedHandle, type SingletonHandle, type Tx } from "../../documents/index.ts";
import type { StoreSelf } from "../../host/index.ts";
import type { JsonValue } from "../../json.ts";
import {
	add,
	and,
	type ColumnRefs,
	type Condition,
	defineTable,
	eq,
	json,
	lt,
	ne,
	not,
	or,
	type Page,
	prefix,
	query,
	type RowOf,
	replacePrefix,
	sub,
	type Table,
} from "../../store/index.ts";

export type FileWrite = {
	readonly space: string;
	readonly path: string;
	readonly mime: string;
	readonly source: string;
	readonly ref?: string;
	readonly key?: string;
	readonly created?: number;
	readonly meta?: JsonValue;
};
export type FileInfo = {
	readonly id: string;
	readonly space: string;
	readonly path: string;
	readonly version: number;
	readonly size: number;
	readonly mime: string;
	readonly source: string;
	readonly ref?: string;
	readonly key?: string;
	readonly created: number;
	readonly meta?: JsonValue;
};
export type FolderInfo = { readonly space: string; readonly path: string; readonly created: number };
export type FolderEntry =
	| { readonly kind: "folder"; readonly folder: FolderInfo }
	| { readonly kind: "file"; readonly file: FileInfo };
export type SpaceSummary = {
	readonly files: number;
	readonly versions: number;
	readonly bytes: number;
	readonly newest: FileInfo[];
};
export type BlobUse = { readonly id: string; readonly size: number; readonly fresh: boolean };

// The JSON column checks metadata; the contract permits any value.
export const MetaSchema = unknown() as TSchema as TUnsafe<JsonValue>;
export const FileSchema = obj({
	id: str(),
	space: str(),
	path: str(),
	version: int(),
	size: int(),
	mime: str(),
	source: str(),
	ref: opt(str()),
	key: opt(str()),
	created: int(),
	meta: opt(MetaSchema),
});
export const FolderSchema = obj({ space: str(), path: str(), created: int() });
export const SummarySchema = obj({ files: int(), versions: int(), bytes: int(), newest: arr(FileSchema) });
const fileColumns = {
	id: str(),
	space: str(),
	folder: str(),
	path: str(),
	version: int(),
	latest: int(),
	blob: str(),
	size: int(),
	mime: str(),
	source: str(),
	ref: str(),
	key: str(),
	created: int(),
	meta: opt(json(MetaSchema, { version: 1 })),
};
const FileRows = defineTable("files", {
	version: 1,
	columns: fileColumns,
	key: ["id"],
	indexes: {
		by_folder: ["space", "folder", "latest", "path"],
		by_path: ["space", "path", "version"],
		by_ref: ["space", "ref", "created"],
		by_key: ["space", "key"],
		by_created: ["space", "created"],
	},
});
const folderColumns = { id: str(), space: str(), parent: str(), path: str(), created: int() };
const FolderRows = defineTable("folders", {
	version: 1,
	columns: folderColumns,
	key: ["id"],
	indexes: { by_path: ["space", "path"], by_parent: ["space", "parent", "path"] },
});
const markColumns = { space: str(), path: str(), last: int() };
const MarkRows = defineTable("paths", { version: 1, columns: markColumns, key: ["space", "path"] });
const blobColumns = { id: str(), size: int(), refs: int() };
const BlobRows = defineTable("blobs", { version: 1, columns: blobColumns, key: ["id"] });
const Summaries = defineState("summary", {
	version: 1,
	schema: SummarySchema,
	keyed: true,
	persist: true,
	initial: (): SpaceSummary => ({ files: 0, versions: 0, bytes: 0, newest: [] }),
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 50,
});
const Usage = defineState("usage", {
	version: 1,
	schema: obj({ bytes: int() }),
	persist: true,
	initial: () => ({ bytes: 0 }),
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 50,
});
export const NEWEST = 20;
export const MAX_PAGE = 1000;
type FileRow = RowOf<typeof fileColumns>;
type FolderRow = RowOf<typeof folderColumns>;
type Released = { lowered: { id: string; by: number }[]; gone: string[]; bytes: number };

export class FilesIndex {
	readonly summary: KeyedHandle<SpaceSummary>;
	readonly usage: SingletonHandle<{ bytes: number }>;
	readonly #self: StoreSelf<Principal>;
	readonly #files: Table<typeof fileColumns, readonly ["id"]>;
	readonly #folders: Table<typeof folderColumns, readonly ["id"]>;
	readonly #marks: Table<typeof markColumns, readonly ["space", "path"]>;
	readonly #blobs: Table<typeof blobColumns, readonly ["id"]>;
	constructor(self: StoreSelf<Principal>) {
		this.#self = self;
		this.#files = self.table(FileRows);
		this.#folders = self.table(FolderRows);
		this.#marks = self.table(MarkRows);
		this.#blobs = self.table(BlobRows);
		this.summary = self.state(Summaries);
		this.usage = self.state(Usage);
	}
	async file(id: string, context: Context): Promise<FileInfo | undefined> {
		const value = await this.#files.get({ id }, context);
		return value === undefined ? undefined : infoOf(value);
	}
	async blobOf(id: string, context: Context): Promise<{ blob: string; size: number } | undefined> {
		const value = await this.#files.get({ id }, context);
		return value === undefined ? undefined : { blob: value.blob, size: value.size };
	}
	async get(space: string, path: string, version: number | undefined, context: Context): Promise<FileInfo | undefined> {
		const value = await this.#version(space, path, version, context);
		return value === undefined ? undefined : infoOf(value);
	}
	async byKey(space: string, key: string, context: Context): Promise<FileInfo | undefined> {
		const page = await this.#files.page(
			query(FileRows).where((row) => and(eq(row.space, space), eq(row.key, key))),
			1,
			context,
		);
		return page.items[0] === undefined ? undefined : infoOf(page.items[0]);
	}
	async byRef(
		space: string,
		ref: string,
		limit: number,
		after: string | undefined,
		context: Context,
	): Promise<Page<FileInfo>> {
		return infos(
			await this.#files.page(
				query(FileRows)
					.where((row) => and(eq(row.space, space), eq(row.ref, ref)))
					.orderBy((row) => row.created),
				limit,
				context,
				after === undefined ? {} : { after },
			),
		);
	}
	async versions(
		space: string,
		path: string,
		limit: number,
		after: string | undefined,
		context: Context,
	): Promise<Page<FileInfo>> {
		return infos(
			await this.#files.page(
				query(FileRows)
					.where((row) => and(eq(row.space, space), eq(row.path, path)))
					.orderBy((row) => row.version, "desc"),
				limit,
				context,
				after === undefined ? {} : { after },
			),
		);
	}
	async list(
		space: string,
		folder: string,
		limit: number,
		after: string | undefined,
		context: Context,
	): Promise<Page<FolderEntry>> {
		const cursor = listCursor(after);
		const items: FolderEntry[] = [];
		if (cursor.part === "folders") {
			const page = await this.#folders.page(
				query(FolderRows)
					.where((row) => and(eq(row.space, space), eq(row.parent, folder)))
					.orderBy((row) => row.path),
				limit,
				context,
				cursor.options,
			);
			items.push(...page.items.map((row): FolderEntry => ({ kind: "folder", folder: folderOf(row) })));
			if (page.next !== undefined) return { items, next: JSON.stringify({ folders: page.next }) };
		}
		const remaining = limit - items.length;
		const page = await this.#files.page(
			query(FileRows)
				.where((row) => and(eq(row.space, space), eq(row.folder, folder), eq(row.latest, 1)))
				.orderBy((row) => row.path),
			Math.max(1, remaining),
			context,
			cursor.part === "files" ? cursor.options : {},
		);
		if (remaining === 0) return page.items.length ? { items, next: '{"files":null}' } : { items };
		items.push(...page.items.map((row): FolderEntry => ({ kind: "file", file: infoOf(row) })));
		return page.next === undefined ? { items } : { items, next: JSON.stringify({ files: page.next }) };
	}
	async exists(space: string, path: string, context: Context): Promise<"file" | "folder" | undefined> {
		if (await this.#folder(space, path, context)) return "folder";
		return (await this.#version(space, path, undefined, context)) ? "file" : undefined;
	}
	async add(id: string, write: FileWrite, blob: BlobUse, context: Context): Promise<FileInfo> {
		const { space, path } = write;
		if (await this.#folder(space, path, context)) throw clash(space, path, "is a folder");
		const folders = await this.#missingFolders(space, parentOf(path), context);
		const previous = await this.#version(space, path, undefined, context);
		const watermark = await this.#marks.get({ space, path }, context);
		const row: FileRow = {
			id,
			space,
			folder: parentOf(path),
			path,
			version: Math.max(previous?.version ?? 0, watermark?.last ?? 0) + 1,
			latest: 1,
			blob: blob.id,
			size: blob.size,
			mime: write.mime,
			source: write.source,
			ref: write.ref ?? "",
			key: write.key ?? "",
			created: write.created ?? Date.now(),
			...(write.meta == null ? {} : { meta: write.meta }),
		};
		const info = infoOf(row);
		const newest = (await this.summary.get(space, context))?.newest ?? [];
		await this.#self.tx(async (tx) => {
			for (const folder of folders) tx.put(this.#folders, folder);
			if (previous) tx.update(this.#files, { id: previous.id }, { latest: 0 });
			tx.put(this.#files, row);
			tx.put(this.#marks, { space, path, last: row.version });
			if (blob.fresh) {
				tx.put(this.#blobs, { id: blob.id, size: blob.size, refs: 1 });
				(await tx.draft(this.usage)).bytes += blob.size;
			} else tx.update(this.#blobs, { id: blob.id }, (stored) => ({ refs: add(stored.refs, 1) }));
			const summary = await tx.draft(this.summary, space);
			summary.files += previous ? 0 : 1;
			summary.versions++;
			summary.bytes += blob.size;
			summary.newest = [info, ...newest].sort(newestFirst).slice(0, NEWEST);
		}, context);
		return info;
	}
	async mkdir(space: string, path: string, context: Context): Promise<FolderInfo> {
		const folders = await this.#missingFolders(space, path, context);
		if (folders.length)
			await this.#self.tx((tx) => {
				for (const folder of folders) tx.put(this.#folders, folder);
			}, context);
		return folderOf((await this.#folder(space, path, context))!);
	}
	async move(space: string, from: string, to: string, context: Context): Promise<void> {
		const kind = await this.exists(space, from, context);
		if (kind === undefined) throw invalid("args", `files: ${space}:${from} does not exist`);
		if (to === from || to.startsWith(from + "/")) throw clash(space, to, `lies inside ${from}`);
		if (await this.exists(space, to, context)) throw clash(space, to, "exists");
		const folders = await this.#missingFolders(space, parentOf(to), context);
		const source = kind === "folder" ? await this.#folder(space, from, context) : undefined;
		const rename = (path: string) => (path === from ? to : to + path.slice(from.length));
		const newest = ((await this.summary.get(space, context))?.newest ?? []).map((info) =>
			info.path === from || info.path.startsWith(from + "/") ? { ...info, path: rename(info.path) } : info,
		);
		const marks: RowOf<typeof markColumns>[] = [];
		for await (const mark of this.#marks.rows(
			query(MarkRows).where((row) => and(eq(row.space, space), or(eq(row.path, from), prefix(row.path, from + "/")))),
			context,
		)) {
			const path = rename(mark.path);
			const existing = await this.#marks.get({ space, path }, context);
			marks.push({ space, path, last: Math.max(mark.last, existing?.last ?? 0) });
		}
		await this.#self.tx(async (tx) => {
			for (const folder of folders) tx.put(this.#folders, folder);
			for (const mark of marks) tx.put(this.#marks, mark);
			if (!source)
				tx.updateWhere(this.#files, (row) => and(eq(row.space, space), eq(row.path, from)), {
					path: to,
					folder: parentOf(to),
				});
			else {
				tx.update(this.#folders, { id: source.id }, { path: to, parent: parentOf(to) });
				tx.updateWhere(
					this.#folders,
					(row) => and(eq(row.space, space), prefix(row.path, from + "/")),
					(row) => ({
						path: replacePrefix(row.path, from + "/", to + "/"),
						parent: replacePrefix(row.parent, from, to),
					}),
				);
				tx.updateWhere(
					this.#files,
					(row) => and(eq(row.space, space), prefix(row.path, from + "/")),
					(row) => ({
						path: replacePrefix(row.path, from + "/", to + "/"),
						folder: replacePrefix(row.folder, from, to),
					}),
				);
			}
			if (newest.length) (await tx.draft(this.summary, space)).newest = newest;
		}, context);
	}
	async remove(id: string, context: Context): Promise<{ space: string; gone: string[] } | undefined> {
		const row = await this.#files.get({ id }, context);
		if (!row) return undefined;
		const older =
			row.latest === 1
				? (
						await this.#files.page(
							query(FileRows)
								.where((other) =>
									and(eq(other.space, row.space), eq(other.path, row.path), lt(other.version, row.version)),
								)
								.orderBy((other) => other.version, "desc"),
							1,
							context,
						)
					).items[0]
				: undefined;
		const gone = await this.#drop(
			row.space,
			[row],
			row.latest === 1 && !older ? 1 : 0,
			(other) => ne(other.id, id),
			context,
			(tx) => {
				tx.delete(this.#files, { id });
				if (older) tx.update(this.#files, { id: older.id }, { latest: 1 });
			},
		);
		return { space: row.space, gone };
	}
	async removePath(space: string, path: string, context: Context): Promise<string[]> {
		const under = (column: Parameters<typeof prefix>[0]) => or(eq(column, path), prefix(column, path + "/"));
		const rows: FileRow[] = [];
		for await (const row of this.#files.rows(
			query(FileRows).where((row) => and(eq(row.space, space), under(row.path))),
			context,
		))
			rows.push(row);
		return this.#drop(
			space,
			rows,
			new Set(rows.map((row) => row.path)).size,
			(row) => not(under(row.path)),
			context,
			(tx) => {
				tx.deleteWhere(this.#files, (row) => and(eq(row.space, space), under(row.path)));
				tx.deleteWhere(this.#folders, (row) => and(eq(row.space, space), under(row.path)));
			},
		);
	}
	async removeSpace(space: string, context: Context): Promise<string[]> {
		const rows: FileRow[] = [];
		for await (const row of this.#files.rows(
			query(FileRows).where((row) => eq(row.space, space)),
			context,
		))
			rows.push(row);
		const released = await this.#released(rows, context);
		await this.#self.tx(async (tx) => {
			tx.deleteWhere(this.#files, (row) => eq(row.space, space));
			tx.deleteWhere(this.#folders, (row) => eq(row.space, space));
			await this.#release(tx, released);
			await tx.retire(this.summary, space);
		}, context);
		return released.gone;
	}
	async hasBlob(id: string, context: Context): Promise<boolean> {
		return (await this.#blobs.get({ id }, context)) !== undefined;
	}
	async #drop(
		space: string,
		rows: readonly FileRow[],
		files: number,
		kept: (row: ColumnRefs<typeof fileColumns>) => Condition,
		context: Context,
		writes: (tx: Tx) => void,
	): Promise<string[]> {
		const released = await this.#released(rows, context);
		const newest = await this.#files.page(
			query(FileRows)
				.where((row) => and(eq(row.space, space), kept(row)))
				.orderBy((row) => row.created, "desc"),
			NEWEST,
			context,
		);
		await this.#self.tx(async (tx) => {
			writes(tx);
			await this.#release(tx, released);
			const summary = await tx.draft(this.summary, space);
			summary.files -= files;
			summary.versions -= rows.length;
			summary.bytes -= rows.reduce((sum, row) => sum + row.size, 0);
			summary.newest = newest.items.map(infoOf);
		}, context);
		return released.gone;
	}
	async #released(rows: readonly FileRow[], context: Context): Promise<Released> {
		const result: Released = { lowered: [], gone: [], bytes: 0 };
		const counts = new Map<string, number>();
		for (const row of rows) counts.set(row.blob, 1 + (counts.get(row.blob) ?? 0));
		for (const [id, by] of counts) {
			const blob = await this.#blobs.get({ id }, context);
			if (!blob) continue;
			if (blob.refs > by) result.lowered.push({ id, by });
			else {
				result.gone.push(id);
				result.bytes += blob.size;
			}
		}
		return result;
	}
	async #release(tx: Tx, value: Released): Promise<void> {
		for (const { id, by } of value.lowered) tx.update(this.#blobs, { id }, (row) => ({ refs: sub(row.refs, by) }));
		for (const id of value.gone) tx.delete(this.#blobs, { id });
		if (value.bytes > 0) (await tx.draft(this.usage)).bytes -= value.bytes;
	}
	async #version(space: string, path: string, version: number | undefined, context: Context) {
		return (
			await this.#files.page(
				query(FileRows).where((row) =>
					and(
						eq(row.space, space),
						eq(row.path, path),
						version === undefined ? eq(row.latest, 1) : eq(row.version, version),
					),
				),
				1,
				context,
			)
		).items[0];
	}
	async #folder(space: string, path: string, context: Context) {
		return (
			await this.#folders.page(
				query(FolderRows).where((row) => and(eq(row.space, space), eq(row.path, path))),
				1,
				context,
			)
		).items[0];
	}
	async #missingFolders(space: string, path: string, context: Context): Promise<FolderRow[]> {
		const missing: FolderRow[] = [];
		const created = Date.now();
		const segments = path ? path.split("/") : [];
		for (let count = 1; count <= segments.length; count++) {
			const folder = segments.slice(0, count).join("/");
			if (!missing.length && (await this.#folder(space, folder, context))) continue;
			if (await this.#version(space, folder, undefined, context)) throw clash(space, folder, "is a file");
			missing.push({ id: randomUUID(), space, parent: parentOf(folder), path: folder, created });
		}
		return missing;
	}
}

function infoOf(row: FileRow): FileInfo {
	return {
		id: row.id,
		space: row.space,
		path: row.path,
		version: row.version,
		size: row.size,
		mime: row.mime,
		source: row.source,
		...(row.ref === "" ? {} : { ref: row.ref }),
		...(row.key === "" ? {} : { key: row.key }),
		created: row.created,
		...(row.meta === undefined ? {} : { meta: row.meta }),
	};
}
function folderOf(row: FolderRow): FolderInfo {
	return { space: row.space, path: row.path, created: row.created };
}
function newestFirst(a: FileInfo, b: FileInfo): number {
	return b.created - a.created || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}
function infos(page: Page<FileRow>): Page<FileInfo> {
	const items = page.items.map(infoOf);
	return page.next === undefined ? { items } : { items, next: page.next };
}
function listCursor(after: string | undefined): { part: "folders" | "files"; options: { after?: string } } {
	if (after === undefined) return { part: "folders", options: {} };
	try {
		const value: unknown = JSON.parse(after);
		if (value && typeof value === "object") {
			if ("folders" in value && typeof value.folders === "string")
				return { part: "folders", options: { after: value.folders } };
			if ("files" in value) {
				if (typeof value.files === "string") return { part: "files", options: { after: value.files } };
				if (value.files === null) return { part: "files", options: {} };
			}
		}
	} catch {}
	throw invalid("args", "files: not a listing cursor");
}
const spacePattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export function checkSpace(space: string): void {
	if (!spacePattern.test(space)) throw invalid("args", `files: "${space}" is no space name (${spacePattern.source})`);
}
export function checkPath(path: string, kind: "folder" | "file"): void {
	if (kind === "folder" && path === "") return;
	if (
		path.length > 1024 ||
		path.includes("\0") ||
		path.split("/").some((part) => part === "" || part === "." || part === "..")
	)
		throw invalid("args", `files: "${path.slice(0, 80)}" is no path (name/name/…, at most 1024)`);
}
export function parentOf(path: string): string {
	return path.slice(0, Math.max(0, path.lastIndexOf("/")));
}
function clash(space: string, path: string, why: string): Error {
	return invalid("args", `files: ${space}:${path} ${why}`, { conflict: path });
}
