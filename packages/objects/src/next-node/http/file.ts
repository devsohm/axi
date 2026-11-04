import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import { basename, extname, relative, isAbsolute, sep } from "node:path";
import type { Context } from "../../context/index.ts";
import { HttpFailure } from "./request.ts";
import type { HttpResponse } from "./response.ts";
export type FileResponseOptions = {
	readonly download?: string;
	readonly inline?: true;
	readonly root?: string;
	readonly ranges?: boolean;
	readonly mime?: string;
};
const groups: readonly [readonly string[], string][] = [
	[["txt", "log"], "text/plain; charset=utf-8"],
	[["md"], "text/markdown; charset=utf-8"],
	[["csv"], "text/csv; charset=utf-8"],
	[["json"], "application/json"],
	[["png"], "image/png"],
	[["jpg", "jpeg"], "image/jpeg"],
	[["gif"], "image/gif"],
	[["webp"], "image/webp"],
	[["avif"], "image/avif"],
	[["mp3"], "audio/mpeg"],
	[["m4a"], "audio/mp4"],
	[["ogg", "opus"], "audio/ogg"],
	[["wav"], "audio/wav"],
	[["flac"], "audio/flac"],
	[["mp4"], "video/mp4"],
	[["webm"], "video/webm"],
	[["mov"], "video/quicktime"],
];
const mime = new Map(
	groups.flatMap(([extensions, value]) => extensions.map((extension) => ["." + extension, value] as const)),
);
export async function fileResponse(given: string, options: FileResponseOptions = {}): Promise<HttpResponse> {
	let path = given,
		size: number;
	try {
		if (options.root !== undefined) {
			const [resolved, base] = await Promise.all([realpath(given), realpath(options.root)]);
			const child = relative(base, resolved);
			if (child === ".." || child.startsWith(".." + sep) || isAbsolute(child))
				throw new HttpFailure(403, "the file lies outside its root");
			path = resolved;
		}
		size = (await stat(path)).size;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") throw new HttpFailure(404, "no such file");
		throw error;
	}
	let handle: Promise<FileHandle> | undefined;
	async function acquire(context: Context): Promise<FileHandle> {
		const file = await open(path, "r");
		const close = (): void => {
			void file.close().catch(() => {});
		};
		if (!context.abortSignal) throw new Error(`fileResponse(${basename(path)}): read outside a request's scope`);
		if (context.abortSignal.aborted) close();
		else context.abortSignal.addEventListener("abort", close, { once: true });
		return file;
	}
	return {
		kind: "bytes",
		mime: options.mime ?? mime.get(extname(path).toLowerCase()) ?? "application/octet-stream",
		size,
		async read(offset, length, context) {
			const file = await (handle ??= acquire(context)),
				buffer = Buffer.allocUnsafe(length);
			const { bytesRead } = await file.read(buffer, 0, length, offset);
			return buffer.subarray(0, bytesRead);
		},
		...(options.download === undefined ? {} : { download: options.download }),
		...(options.inline === undefined ? {} : { inline: options.inline }),
		...(options.ranges === undefined ? {} : { ranges: options.ranges }),
	};
}
