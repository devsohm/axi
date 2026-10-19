import { constants, type Dir, type Stats } from "node:fs";
import { lstat, open, opendir, type FileHandle } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Context } from "@axi/chord";
import { StreamDecoder } from "./decode.ts";
import {
	err,
	FileError,
	ok,
	toError,
	type BinaryReader,
	type DirReader,
	type FileInfo,
	type FileKind,
	type LineScan,
	type Result,
	type TextLine,
	type TextLineReader,
} from "./index.ts";
import { LineScanner } from "./line-scan.ts";

export function fileError(value: unknown, path: string | undefined): FileError {
	if (value instanceof FileError) return value;
	const cause = toError(value);
	const code = "code" in cause ? cause.code : undefined;
	const mapped =
		code === "ABORT_ERR"
			? "aborted"
			: code === "ENOENT"
				? "not_found"
				: code === "EACCES" || code === "EPERM"
					? "permission_denied"
					: code === "ENOTDIR"
						? "not_directory"
						: code === "EISDIR"
							? "is_directory"
							: code === "EINVAL"
								? "invalid"
								: "unknown";
	return new FileError(
		mapped,
		cause.message,
		"path" in cause && typeof cause.path === "string" ? cause.path : path,
		cause,
	);
}

export function checkFileContext(context: Context, path: string | undefined): void {
	if (context.abortSignal?.aborted) throw new FileError("aborted", "aborted", path);
}

export async function fileOperation<T>(
	path: string | undefined,
	context: Context,
	run: () => Promise<T>,
): Promise<Result<T, FileError>> {
	try {
		checkFileContext(context, path);
		return ok(await run());
	} catch (error) {
		return err(fileError(error, path));
	}
}

export function describeFile(path: string, stat: Stats): FileInfo | undefined {
	const kind: FileKind | undefined = stat.isSymbolicLink()
		? "symlink"
		: stat.isFile()
			? "file"
			: stat.isDirectory()
				? "directory"
				: undefined;
	return kind === undefined ? undefined : { name: basename(path), path, kind, size: stat.size, mtimeMs: stat.mtimeMs };
}

function requireOpen(closed: boolean, path: string, reader: string): void {
	if (closed) throw new FileError("invalid", `${reader} is closed`, path);
}

function natural(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 0;
}

class FileLines implements TextLineReader {
	readonly #handle: FileHandle;
	readonly #path: string;
	readonly #decoder = new StreamDecoder();
	#offset = 0;
	#text = "";
	#ended = false;
	#closed = false;
	constructor(handle: FileHandle, path: string) {
		this.#handle = handle;
		this.#path = path;
	}
	readLine(context: Context): Promise<Result<TextLine | undefined, FileError>> {
		return fileOperation(this.#path, context, async () => {
			requireOpen(this.#closed, this.#path, "Text line reader");
			while (true) {
				const newline = this.#text.indexOf("\n");
				if (newline !== -1) {
					const text = this.#text.slice(0, newline);
					this.#text = this.#text.slice(newline + 1);
					return { text, terminated: true };
				}
				if (this.#ended) {
					if (this.#text.length === 0) return undefined;
					const text = this.#text;
					this.#text = "";
					return { text, terminated: false };
				}
				const buffer = Buffer.allocUnsafe(65536);
				const { bytesRead } = await this.#handle.read(buffer, 0, buffer.length, this.#offset);
				checkFileContext(context, this.#path);
				this.#offset += bytesRead;
				this.#ended = bytesRead === 0;
				this.#text += this.#ended ? this.#decoder.decode() : this.#decoder.decode(buffer.subarray(0, bytesRead));
			}
		});
	}
	async close(_context: Context): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#text = "";
		await this.#handle.close().catch(() => {});
	}
}

class FileBytes implements BinaryReader {
	readonly #handle: FileHandle;
	readonly #path: string;
	#closed = false;
	constructor(handle: FileHandle, path: string) {
		this.#handle = handle;
		this.#path = path;
	}
	info(context: Context): Promise<Result<FileInfo, FileError>> {
		return fileOperation(this.#path, context, async () => {
			requireOpen(this.#closed, this.#path, "Binary reader");
			const info = describeFile(this.#path, await this.#handle.stat());
			if (info === undefined) throw new FileError("invalid", "Not a regular file", this.#path);
			return info;
		});
	}
	read(offset: number, length: number, context: Context): Promise<Result<Uint8Array, FileError>> {
		return fileOperation(this.#path, context, async () => {
			requireOpen(this.#closed, this.#path, "Binary reader");
			if (!natural(offset) || !natural(length))
				throw new FileError("invalid", "Offset and length must be non-negative safe integers", this.#path);
			const chunks: Uint8Array[] = [];
			let total = 0;
			while (total < length) {
				const buffer = new Uint8Array(Math.min(length - total, 1024 * 1024));
				const { bytesRead } = await this.#handle.read(buffer, 0, buffer.length, offset + total);
				checkFileContext(context, this.#path);
				if (bytesRead === 0) break;
				chunks.push(buffer.subarray(0, bytesRead));
				total += bytesRead;
			}
			if (chunks.length === 1) return chunks[0]!;
			const bytes = new Uint8Array(total);
			let position = 0;
			for (const chunk of chunks) {
				bytes.set(chunk, position);
				position += chunk.length;
			}
			return bytes;
		});
	}
	scanLines(options: { startLine: number; endLine?: number }, context: Context): Promise<Result<LineScan, FileError>> {
		return fileOperation(this.#path, context, async () => {
			requireOpen(this.#closed, this.#path, "Binary reader");
			if (
				!natural(options.startLine) ||
				(options.endLine !== undefined &&
					options.endLine !== Infinity &&
					(!natural(options.endLine) || options.endLine <= options.startLine))
			)
				throw new FileError("invalid", "Invalid line range", this.#path);
			const scanner = new LineScanner(options.startLine, options.endLine);
			const buffer = Buffer.allocUnsafe(65536);
			for (let offset = 0; ; ) {
				const { bytesRead } = await this.#handle.read(buffer, 0, buffer.length, offset);
				checkFileContext(context, this.#path);
				if (!bytesRead) return scanner.finish();
				scanner.push(buffer.subarray(0, bytesRead));
				offset += bytesRead;
			}
		});
	}
	async close(_context: Context): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await this.#handle.close().catch(() => {});
	}
}

class DirectoryPages implements DirReader {
	readonly #dir: Dir;
	readonly #path: string;
	#closed = false;
	#ended = false;
	constructor(dir: Dir, path: string) {
		this.#dir = dir;
		this.#path = path;
	}
	next(maxEntries: number, context: Context): Promise<Result<{ entries: FileInfo[]; done: boolean }, FileError>> {
		return fileOperation(this.#path, context, async () => {
			requireOpen(this.#closed, this.#path, "Directory reader");
			if (!natural(maxEntries) || maxEntries === 0)
				throw new FileError("invalid", "maxEntries must be a positive safe integer", this.#path);
			const entries: FileInfo[] = [];
			while (!this.#ended && entries.length < maxEntries) {
				const entry = await this.#dir.read();
				if (entry === null) {
					this.#ended = true;
					break;
				}
				checkFileContext(context, this.#path);
				const path = join(this.#path, entry.name);
				try {
					const info = describeFile(path, await lstat(path));
					if (info) entries.push(info);
				} catch (error) {
					if (fileError(error, path).code !== "not_found") throw error;
				}
			}
			return { entries, done: this.#ended };
		});
	}
	async close(_context: Context): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await this.#dir.close().catch(() => {});
	}
}

async function openRegular(path: string, noFollow = false): Promise<FileHandle> {
	if (noFollow && process.platform === "win32" && (await lstat(path)).isSymbolicLink())
		throw new FileError("invalid", "Refusing to follow a symbolic link", path);
	const flags =
		constants.O_RDONLY |
		(process.platform === "win32" ? 0 : constants.O_NONBLOCK | (noFollow ? constants.O_NOFOLLOW : 0));
	const handle = await open(path, flags);
	try {
		const info = await handle.stat();
		if (info.isDirectory()) throw new FileError("is_directory", "EISDIR: illegal operation on a directory, read", path);
		if (!info.isFile()) throw new FileError("invalid", "Not a regular file", path);
		return handle;
	} catch (error) {
		await handle.close().catch(() => {});
		throw error;
	}
}

export async function openLines(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
	return fileOperation(path, context, async () => {
		const handle = await open(path, "r");
		await checkAcquisition(handle, context, path);
		return new FileLines(handle, path);
	});
}
export async function openBytes(
	path: string,
	noFollow: boolean,
	context: Context,
): Promise<Result<BinaryReader, FileError>> {
	return fileOperation(path, context, async () => {
		try {
			const handle = await openRegular(path, noFollow);
			await checkAcquisition(handle, context, path);
			return new FileBytes(handle, path);
		} catch (error) {
			if (noFollow && error instanceof Error && "code" in error && (error.code === "ELOOP" || error.code === "EMLINK"))
				throw new FileError("invalid", "Refusing to follow a symbolic link", path, error);
			throw error;
		}
	});
}
export async function openDirectory(path: string, context: Context): Promise<Result<DirReader, FileError>> {
	return fileOperation(path, context, async () => {
		const dir = await opendir(path);
		await checkAcquisition(dir, context, path);
		return new DirectoryPages(dir, path);
	});
}

async function checkAcquisition(resource: { close(): Promise<void> }, context: Context, path: string): Promise<void> {
	if (!context.abortSignal?.aborted) return;
	await resource.close().catch(() => {});
	checkFileContext(context, path);
}
