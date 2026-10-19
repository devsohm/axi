import { posix, win32 } from "node:path";
import type { Context } from "@axi/chord";
import {
	err,
	FileError,
	ok,
	StreamDecoder,
	type BinaryReader,
	type DirReader,
	type FileInfo,
	type FileKind,
	type LineScan,
	type Result,
	type TextLine,
	type TextLineReader,
} from "@axi/durable/env";
import { type Connection, type Json, nodePlatform, RemoteError } from "./connection.ts";
import { abortResult, toFileError } from "./errors.ts";
import type { RemoteExecutionEnv } from "./remote-env.ts";

type PlatformPath = typeof posix;

export type FileRecord = { name: string; kind: FileKind | "other"; size: number; mtimeSec: number; mtimeNsec: number };
export type DirectoryEntry = { name: string; raw?: number[]; info?: FileRecord; error?: Json };
export async function remotePath(connection: Connection): Promise<PlatformPath> {
	return nodePlatform(await connection.info()).platform === "win32" ? win32 : posix;
}
export function fileInfo(path: string, record: FileRecord, paths: PlatformPath): Result<FileInfo, FileError> {
	if (record.kind === "other") return err(new FileError("invalid", "Unsupported file type", path));
	return ok({
		name: paths.basename(path),
		path,
		kind: record.kind,
		size: record.size,
		mtimeMs: record.mtimeSec * 1000 + record.mtimeNsec / 1e6,
	});
}
export async function readRange(
	read: (at: number, size: number) => Promise<Uint8Array>,
	offset: number,
	length: number,
	chunkSize: number,
	aborted: () => boolean,
): Promise<{ chunks: Uint8Array[]; total: number } | undefined> {
	const chunks: Uint8Array[] = [];
	let total = 0,
		next = offset;
	const queue: { size: number; result: Promise<Uint8Array> }[] = [];
	while (total < length) {
		while (queue.length < 8 && next < offset + length) {
			const size = Math.min(chunkSize, offset + length - next),
				result = read(next, size);
			void result.catch(() => {});
			queue.push({ size, result });
			next += size;
		}
		const head = queue.shift()!,
			bytes = await head.result;
		if (aborted()) return undefined;
		if (!bytes.length) break;
		chunks.push(bytes);
		total += bytes.length;
		if (bytes.length < head.size) {
			queue.length = 0;
			next = offset + total;
		}
	}
	return { chunks, total };
}
export class Handle {
	readonly env: RemoteExecutionEnv;
	readonly id: number;
	readonly session: number;
	readonly path: string;
	constructor(env: RemoteExecutionEnv, id: number, session: number, path: string) {
		this.env = env;
		this.id = id;
		this.session = session;
		this.path = path;
	}
	request(op: string, fields: Json = {}, options: { signal?: AbortSignal; payload?: Uint8Array } = {}) {
		return this.env.connection.request(op, { ...fields, handle: this.id }, { ...options, session: this.session });
	}
	async read(offset: number | undefined, length: number): Promise<Uint8Array> {
		return (await this.request("pread", { ...(offset === undefined ? {} : { offset }), length })).payload;
	}
	async close(): Promise<void> {
		await this.request("close").catch(() => {});
	}
}
export class RemoteBinaryReader implements BinaryReader {
	readonly #handle: Handle;
	#closed = false;
	constructor(handle: Handle) {
		this.#handle = handle;
	}
	#early<T>(context: Context): Result<T, FileError> | undefined {
		return (
			abortResult<T>(context.abortSignal, this.#handle.path) ??
			(this.#closed ? err(new FileError("invalid", "Binary reader is closed", this.#handle.path)) : undefined)
		);
	}
	async info(context: Context): Promise<Result<FileInfo, FileError>> {
		const early = this.#early<FileInfo>(context);
		if (early) return early;
		try {
			const { json } = await this.#handle.request("fstat");
			return fileInfo(this.#handle.path, json as unknown as FileRecord, await remotePath(this.#handle.env.connection));
		} catch (error) {
			return err(toFileError(error, this.#handle.path));
		}
	}
	async read(offset: number, length: number, context: Context): Promise<Result<Uint8Array, FileError>> {
		const early = this.#early<Uint8Array>(context);
		if (early) return early;
		if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0)
			return err(new FileError("invalid", "Offset and length must be non-negative safe integers", this.#handle.path));
		try {
			const result = await readRange(
				(at, size) => this.#handle.read(at, size),
				offset,
				length,
				262144,
				() => context.abortSignal?.aborted === true,
			);
			if (!result) return err(new FileError("aborted", "aborted", this.#handle.path));
			if (result.chunks.length === 1) return ok(result.chunks[0]!);
			const bytes = new Uint8Array(result.total);
			let at = 0;
			for (const chunk of result.chunks) {
				bytes.set(chunk, at);
				at += chunk.length;
			}
			return ok(bytes);
		} catch (error) {
			return err(toFileError(error, this.#handle.path));
		}
	}
	async scanLines(
		options: { startLine: number; endLine?: number },
		context: Context,
	): Promise<Result<LineScan, FileError>> {
		const early = this.#early<LineScan>(context);
		if (early) return early;
		const { startLine, endLine } = options;
		if (
			!Number.isSafeInteger(startLine) ||
			startLine < 0 ||
			(endLine !== undefined && (!Number.isSafeInteger(endLine) || endLine <= startLine))
		)
			return err(new FileError("invalid", "Invalid line range", this.#handle.path));
		try {
			const { json } = await this.#handle.request(
				"scanLines",
				{
					startLine,
					...(endLine === undefined ? {} : { endLine }),
				},
				context.abortSignal ? { signal: context.abortSignal } : {},
			);
			return ok(json as unknown as LineScan);
		} catch (error) {
			return err(toFileError(error, this.#handle.path));
		}
	}
	async close(_context: Context): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await this.#handle.close();
	}
}
export class RemoteDirReader implements DirReader {
	#done = false;
	#closed = false;
	readonly #handle: Handle;
	constructor(handle: Handle) {
		this.#handle = handle;
	}
	async next(maxEntries: number, context: Context): Promise<Result<{ entries: FileInfo[]; done: boolean }, FileError>> {
		const aborted = abortResult<{ entries: FileInfo[]; done: boolean }>(context.abortSignal, this.#handle.path);
		if (aborted) return aborted;
		if (this.#closed) return err(new FileError("invalid", "Directory reader is closed", this.#handle.path));
		if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0)
			return err(new FileError("invalid", "maxEntries must be a positive safe integer", this.#handle.path));
		const entries: FileInfo[] = [];
		try {
			const paths = await remotePath(this.#handle.env.connection);
			while (!this.#done && entries.length < maxEntries) {
				const { json } = await this.#handle.request("readdir", { max: maxEntries - entries.length });
				const afterRead = abortResult<{ entries: FileInfo[]; done: boolean }>(context.abortSignal, this.#handle.path);
				if (afterRead) return afterRead;
				for (const entry of json.entries as DirectoryEntry[]) {
					const path = paths.resolve(this.#handle.path, entry.name);
					if (entry.error !== undefined) {
						if (entry.error.code === "ENOENT") continue;
						return err(toFileError(new RemoteError(entry.error), path));
					}
					const info = fileInfo(path, entry.info!, paths);
					if (info.ok) entries.push(info.value);
				}
				this.#done = json.done === true;
			}
			return ok({ entries, done: this.#done });
		} catch (error) {
			return err(toFileError(error, this.#handle.path));
		}
	}
	async close(_context: Context): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await this.#handle.close();
	}
}
export class RemoteTextLineReader implements TextLineReader {
	readonly #decoder = new StreamDecoder();
	#offset = 0;
	#text = "";
	#eof = false;
	#closed = false;
	readonly #handle: Handle;
	constructor(handle: Handle) {
		this.#handle = handle;
	}
	async readLine(context: Context): Promise<Result<TextLine | undefined, FileError>> {
		const aborted = abortResult<TextLine | undefined>(context.abortSignal, this.#handle.path);
		if (aborted) return aborted;
		if (this.#closed) return err(new FileError("invalid", "Text line reader is closed", this.#handle.path));
		try {
			while (true) {
				const end = this.#text.indexOf("\n");
				if (end >= 0) {
					const text = this.#text.slice(0, end);
					this.#text = this.#text.slice(end + 1);
					return ok({ text, terminated: true });
				}
				if (this.#eof) {
					if (!this.#text.length) return ok(undefined);
					const text = this.#text;
					this.#text = "";
					return ok({ text, terminated: false });
				}
				const bytes = await this.#handle.read(this.#offset, 65536);
				const afterRead = abortResult<TextLine | undefined>(context.abortSignal, this.#handle.path);
				if (afterRead) return afterRead;
				this.#offset += bytes.length;
				this.#eof = bytes.length === 0;
				this.#text += this.#decoder.decode(this.#eof ? undefined : bytes);
			}
		} catch (error) {
			return err(toFileError(error, this.#handle.path));
		}
	}
	async close(_context: Context): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#text = "";
		await this.#handle.close();
	}
}
