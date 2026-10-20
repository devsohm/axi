import { randomUUID } from "node:crypto";
import { posix, win32 } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import type { Context } from "@axi/chord";
import {
	err,
	ExecutionError,
	FileError,
	ok,
	type BinaryReader,
	type DirReader,
	type ExecutionEnv,
	type FileInfo,
	type FileListing,
	type FileWatcher,
	type ListFilesOptions,
	type Result,
	type ShellExecOptions,
	type ShellExecResult,
	type ShellOutputInfo,
	type ShellOutputSkip,
	type TextLineReader,
	type WatchChange,
	type WatchTarget,
} from "@axi/durable/env";
import { type Connection, type Json, nodePlatform, RemoteError } from "./connection.ts";
import { abortResult, toFileError } from "./errors.ts";
import { listFilesOver } from "./list-files.ts";
import {
	type DirectoryEntry,
	type FileRecord,
	fileInfo,
	Handle,
	readRange,
	RemoteBinaryReader,
	RemoteDirReader,
	remotePath,
	RemoteTextLineReader,
} from "./remote-files.ts";
import { RemoteWatcher, type RemoteWatchOptions } from "./watch.ts";

export interface RemoteExecutionEnvOptions {
	connection: Connection;
	id: string;
	cwd: string;
	shellPath?: string;
	shellEnv?: Record<string, string>;
	watch?: RemoteWatchOptions;
}
export { remotePath } from "./remote-files.ts";
export type { RemoteInfo } from "./connection.ts";

export class RemoteExecutionEnv implements ExecutionEnv {
	readonly id: string;
	cwd: string;
	readonly connection: Connection;
	readonly #shellPath: string | undefined;
	readonly #shellEnv: Record<string, string> | undefined;
	readonly #watchOptions: RemoteWatchOptions;
	readonly #running = new Map<number, number>();
	constructor(options: RemoteExecutionEnvOptions) {
		this.id = options.id;
		this.cwd = options.cwd;
		this.connection = options.connection;
		this.#shellPath = options.shellPath;
		this.#shellEnv = options.shellEnv;
		this.#watchOptions = options.watch ?? {};
	}
	async #resolve(input: string): Promise<string> {
		const info = await this.connection.info(),
			windows = nodePlatform(info).platform === "win32",
			paths = windows ? win32 : posix;
		let path = input;
		if (path === "~") path = info.home;
		else if (path.startsWith("~/") || (windows && path.startsWith("~\\"))) path = paths.join(info.home, path.slice(2));
		else if (path.startsWith("file://")) {
			try {
				path = fileURLToPath(path, { windows });
			} catch {}
		}
		if (paths.isAbsolute(path)) return paths.resolve(path);
		const drive = windows ? /^([a-zA-Z]:)(?![\\/])/.exec(path)?.[1] : undefined;
		if (drive && drive.toLowerCase() !== this.cwd.slice(0, 2).toLowerCase()) {
			let base = info.driveCwds[drive.toUpperCase()] ?? info.cwd;
			if (base.slice(0, 2).toLowerCase() !== drive.toLowerCase() && base[2] === "\\") base = `${drive}\\`;
			return win32.resolve(base, path);
		}
		return paths.resolve(this.cwd, path);
	}
	async #file<T>(
		path: string,
		context: Context,
		action: (resolved: string) => Promise<T>,
		after = false,
	): Promise<Result<T, FileError>> {
		let resolved: string;
		try {
			resolved = await this.#resolve(path);
		} catch (error) {
			return err(toFileError(error, path));
		}
		const before = abortResult<T>(context.abortSignal, resolved);
		if (before) return before;
		try {
			const value = await action(resolved);
			return (after ? abortResult<T>(context.abortSignal, resolved) : undefined) ?? ok(value);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}
	async #open(path: string, op: "open" | "opendir", fields: Json = {}): Promise<{ handle: Handle; json: Json }> {
		const { json, session } = await this.connection.request(op, { path, ...fields });
		return { handle: new Handle(this, json.handle as number, session, path), json };
	}
	async absolutePath(path: string, _context: Context): Promise<Result<string, FileError>> {
		try {
			return ok(await this.#resolve(path));
		} catch (error) {
			return err(toFileError(error, path));
		}
	}
	async joinPath(parts: string[], _context: Context): Promise<Result<string, FileError>> {
		try {
			return ok((await remotePath(this.connection)).join(...parts));
		} catch (error) {
			return err(toFileError(error));
		}
	}
	#readFile(path: string, text: true, context: Context): Promise<Result<string, FileError>>;
	#readFile(path: string, text: false, context: Context): Promise<Result<Uint8Array, FileError>>;
	async #readFile(path: string, text: boolean, context: Context): Promise<Result<string | Uint8Array, FileError>> {
		const signal = context.abortSignal;
		return this.#file(path, context, async (resolved) => {
			const { handle, json } = await this.#open(resolved, "open", { mode: "read" });
			const check = () => {
				if (signal?.aborted) throw new FileError("aborted", "The operation was aborted", resolved);
			};
			try {
				if (json.statError !== undefined) throw new RemoteError(json.statError as Json);
				check();
				const stat = json.stat as FileRecord,
					size = stat.kind === "file" ? stat.size : 0;
				if (size > 2147483647) throw new FileError("unknown", `File size (${size}) is greater than 2 GiB`, resolved);
				if (size === 0) {
					const chunks: Uint8Array[] = [],
						decoder = new StringDecoder("utf8");
					let total = 0,
						result = "";
					while (true) {
						check();
						const bytes = await handle.read(undefined, 65536);
						if (!bytes.length) break;
						chunks.push(bytes);
						total += bytes.length;
						if (text) result += decoder.write(bytes);
					}
					return text ? (total ? result + decoder.end() : "") : Buffer.concat(chunks, total);
				}
				if (!text) {
					if (size <= 524288) return Buffer.from(await handle.read(0, size));
					const result = await readRange(
						(at, length) => handle.read(at, length),
						0,
						size,
						524288,
						() => signal?.aborted === true,
					);
					if (!result) throw new FileError("aborted", "The operation was aborted", resolved);
					return Buffer.concat(result.chunks, result.total);
				}
				const decoder = new StringDecoder("utf8"),
					length = Math.min(size, 524288),
					pending: Promise<Uint8Array>[] = [];
				let next = 0,
					total = 0,
					first = true,
					result = "";
				while (true) {
					while (pending.length < 8) {
						const read = handle.read(next, length);
						void read.catch(() => {});
						pending.push(read);
						next += length;
					}
					const bytes = await pending.shift()!;
					check();
					total += bytes.length;
					if (!bytes.length || total === size || bytes.length !== length)
						return first ? Buffer.from(bytes).toString("utf8") : result + decoder.end(Buffer.from(bytes));
					result += decoder.write(Buffer.from(bytes));
					first = false;
				}
			} finally {
				await handle.close();
			}
		});
	}
	async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
		return await this.#readFile(path, true, context);
	}
	async readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
		return await this.#readFile(path, false, context);
	}
	async openBinaryReader(
		path: string,
		options: { noFollow?: boolean } | undefined,
		context: Context,
	): Promise<Result<BinaryReader, FileError>> {
		const opened = await this.#file(
			path,
			context,
			async (resolved) => (await this.#open(resolved, "open", { noFollow: options?.noFollow === true })).handle,
		);
		if (!opened.ok) return opened;
		const aborted = abortResult<BinaryReader>(context.abortSignal, opened.value.path);
		if (aborted) {
			await opened.value.close();
			return aborted;
		}
		return ok(new RemoteBinaryReader(opened.value));
	}
	async openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
		const opened = await this.#file(
			path,
			context,
			async (resolved) => (await this.#open(resolved, "open", { mode: "read" })).handle,
		);
		if (!opened.ok) return opened;
		const aborted = abortResult<TextLineReader>(context.abortSignal, opened.value.path);
		if (aborted) {
			await opened.value.close();
			return aborted;
		}
		return ok(new RemoteTextLineReader(opened.value));
	}
	async openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
		const opened = await this.#file(path, context, async (resolved) => (await this.#open(resolved, "opendir")).handle);
		if (!opened.ok) return opened;
		const aborted = abortResult<DirReader>(context.abortSignal, opened.value.path);
		if (aborted) {
			await opened.value.close();
			return aborted;
		}
		return ok(new RemoteDirReader(opened.value));
	}
	async readTextLines(
		path: string,
		options: { maxLines?: number } | undefined,
		context: Context,
	): Promise<Result<string[], FileError>> {
		if (options?.maxLines !== undefined && options.maxLines <= 0) return ok([]);
		const opened = await this.openTextLineReader(path, context);
		if (!opened.ok) return opened;
		const lines: string[] = [];
		try {
			while (options?.maxLines === undefined || lines.length < options.maxLines) {
				const line = await opened.value.readLine(context);
				if (!line.ok) return line;
				if (!line.value) break;
				lines.push(line.value.text);
			}
			return ok(lines);
		} finally {
			await opened.value.close(context);
		}
	}
	async #write(
		path: string,
		content: string | Uint8Array,
		append: boolean,
		context: Context,
	): Promise<Result<void, FileError>> {
		const bytes = typeof content === "string" ? Buffer.from(content) : content;
		const signal = append ? undefined : context.abortSignal;
		return this.#file(
			path,
			context,
			async (resolved) => {
				const keep = bytes.length > 524288;
				const reply = await this.connection.request(
					"write",
					{ path: resolved, append, keep },
					{ payload: bytes.subarray(0, 524288) },
				);
				if (!keep) return;
				const handle = new Handle(this, reply.json.handle as number, reply.session, resolved),
					pending: Promise<unknown>[] = [];
				try {
					for (let offset = 524288; offset < bytes.length; offset += 524288) {
						if (signal?.aborted) {
							const failed = (await Promise.allSettled(pending)).find((result) => result.status === "rejected");
							if (failed) throw failed.reason;
							throw new FileError("aborted", "The operation was aborted", resolved);
						}
						const write = handle.request("writeChunk", {}, { payload: bytes.subarray(offset, offset + 524288) });
						void write.catch(() => {});
						pending.push(write);
						if (pending.length >= 8) await pending.shift();
					}
					for (const write of pending) await write;
				} finally {
					await Promise.allSettled(pending);
					await handle.close();
				}
			},
			append,
		);
	}
	writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		return this.#write(path, content, false, context);
	}
	appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		return this.#write(path, content, true, context);
	}
	async truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>> {
		return this.#file(
			path,
			context,
			async (resolved) => {
				if (!Number.isSafeInteger(size) || size < 0)
					throw new FileError("invalid", "File size must be a non-negative safe integer", resolved);
				await this.connection.request("truncate", { path: resolved, size });
			},
			true,
		);
	}
	flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
		return this.#file(
			path,
			context,
			async (resolved) => {
				await this.connection.request("fsync", { path: resolved });
			},
			true,
		);
	}
	async renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> {
		let source = sourcePath,
			destination: string;
		try {
			source = await this.#resolve(sourcePath);
			destination = await this.#resolve(destinationPath);
		} catch (error) {
			return err(toFileError(error, sourcePath));
		}
		const aborted = abortResult<void>(context.abortSignal, destination);
		if (aborted) return aborted;
		try {
			await this.connection.request("rename", { path: source, to: destination });
			return ok(undefined);
		} catch (error) {
			return err(toFileError(error, source));
		}
	}
	async fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
		const result = await this.#file(path, context, async (resolved) => {
			const { json } = await this.connection.request("lstat", { path: resolved });
			const paths = await remotePath(this.connection);
			return fileInfo(resolved, json as unknown as FileRecord, paths);
		});
		return result.ok ? result.value : result;
	}
	listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
		return this.#file(path, context, async (resolved) => {
			const { handle } = await this.#open(resolved, "opendir"),
				entries: DirectoryEntry[] = [];
			try {
				let done = false;
				while (!done) {
					const { json } = await handle.request("readdir", { max: 1000 });
					entries.push(...(json.entries as DirectoryEntry[]));
					done = json.done === true;
				}
			} finally {
				await handle.close();
			}
			const paths = await remotePath(this.connection);
			if (paths === posix) {
				const bytes = (entry: DirectoryEntry) => Buffer.from(entry.raw ?? Buffer.from(entry.name));
				entries.sort((a, b) => Buffer.compare(bytes(a), bytes(b)));
			}
			const result: FileInfo[] = [];
			for (const entry of entries) {
				if (context.abortSignal?.aborted) throw new FileError("aborted", "aborted", resolved);
				const path = paths.resolve(resolved, entry.name);
				if (entry.error !== undefined) throw toFileError(new RemoteError(entry.error), path);
				const info = fileInfo(path, entry.info!, paths);
				if (info.ok) result.push(info.value);
			}
			return result;
		});
	}
	async listFiles(
		path: string,
		options: ListFilesOptions | undefined,
		context: Context,
	): Promise<Result<FileListing, FileError>> {
		try {
			return listFilesOver(this.connection, await this.#resolve(path), options, context);
		} catch (error) {
			return err(toFileError(error, path));
		}
	}
	canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
		return this.#file(
			path,
			context,
			async (resolved) => (await this.connection.request("realpath", { path: resolved })).json.path as string,
		);
	}
	async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
		const result = await this.fileInfo(path, context);
		return result.ok ? ok(true) : result.error.code === "not_found" ? ok(false) : err(result.error);
	}
	createDir(
		path: string,
		options: { recursive?: boolean } | undefined,
		context: Context,
	): Promise<Result<void, FileError>> {
		return this.#file(path, context, async (resolved) => {
			await this.connection.request("mkdir", { path: resolved, recursive: options?.recursive ?? true });
		});
	}
	remove(
		path: string,
		options: { recursive?: boolean; force?: boolean } | undefined,
		context: Context,
	): Promise<Result<void, FileError>> {
		return this.#file(path, context, async (resolved) => {
			await this.connection.request("rm", {
				path: resolved,
				recursive: options?.recursive ?? false,
				force: options?.force ?? false,
			});
		});
	}
	async createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
		const aborted = abortResult<string>(context.abortSignal);
		if (aborted) return aborted;
		try {
			const info = await this.connection.info(),
				paths = await remotePath(this.connection);
			return ok(
				(await this.connection.request("mkdtemp", { path: paths.join(info.tmpdir, prefix ?? "tmp-") })).json
					.path as string,
			);
		} catch (error) {
			return err(toFileError(error));
		}
	}
	async createTempFile(
		options: { prefix?: string; suffix?: string } | undefined,
		context: Context,
	): Promise<Result<string, FileError>> {
		const dir = await this.createTempDir("tmp-", context);
		if (!dir.ok) return dir;
		let path = "";
		try {
			path = (await remotePath(this.connection)).join(
				dir.value,
				`${options?.prefix ?? ""}${randomUUID()}${options?.suffix ?? ""}`,
			);
			await this.connection.request("write", { path, append: false, parents: false }, { payload: new Uint8Array(0) });
			return ok(path);
		} catch (error) {
			return err(toFileError(error, path));
		}
	}
	async watch(
		targets: readonly WatchTarget[],
		notify: (change: WatchChange) => void,
		context: Context,
	): Promise<Result<FileWatcher, FileError>> {
		const before = abortResult<FileWatcher>(context.abortSignal);
		if (before) return before;
		try {
			const resolved = await Promise.all(
				targets.map(async (target) => ({ ...target, path: await this.#resolve(target.path) })),
			);
			const after = abortResult<FileWatcher>(context.abortSignal);
			if (after) return after;
			const watcher = await RemoteWatcher.open(this.connection, resolved, notify, this.#watchOptions);
			const cancelled = abortResult<FileWatcher>(context.abortSignal);
			if (cancelled) {
				await watcher.close(context);
				return cancelled;
			}
			return ok(watcher);
		} catch (error) {
			return err(toFileError(error));
		}
	}
	async exec(
		command: string | readonly string[],
		options: ShellExecOptions | undefined,
		context: Context,
	): Promise<Result<ShellExecResult, ExecutionError>> {
		const signal = context.abortSignal;
		if (signal?.aborted) return err(new ExecutionError("aborted", "aborted"));
		const timeout = options?.timeout;
		if (timeout !== undefined) {
			if (!Number.isFinite(timeout) || timeout <= 0)
				return err(new ExecutionError("timeout", "Invalid timeout: must be a finite number of seconds"));
			if (timeout * 1000 > 2147483647)
				return err(new ExecutionError("timeout", "Invalid timeout: maximum is 2147483.647 seconds"));
		}
		const inheritEnv = options?.inheritEnv ?? true;
		let cwd: string;
		try {
			cwd = options?.cwd ? await this.#resolve(options.cwd) : this.cwd;
		} catch (error) {
			return err(new ExecutionError("unknown", error instanceof Error ? error.message : String(error)));
		}
		if (signal?.aborted) return err(new ExecutionError("aborted", "aborted"));
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries({ ...(inheritEnv ? this.#shellEnv : {}), ...options?.env }))
			if (value !== undefined) env[key.toWellFormed()] = value;
		const abort = new AbortController(),
			cancel = () => abort.abort();
		let callbackError: ExecutionError | undefined,
			settled = false,
			requestId: number | undefined;
		signal?.addEventListener("abort", cancel, { once: true });
		try {
			const { json } = await this.connection.request(
				"exec",
				{
					...(typeof command === "string" ? { command } : { argv: [...command] }),
					cwd,
					env,
					inheritEnv,
					...(this.#shellPath === undefined ? {} : { shellPath: this.#shellPath }),
					...(timeout === undefined ? {} : { timeoutMs: timeout * 1000 }),
					...(options?.spill === undefined ? {} : { spill: options.spill }),
					...(options?.window === undefined ? {} : { window: options.window }),
				},
				{
					signal: abort.signal,
					onStart: (id, session) => {
						requestId = id;
						this.#running.set(id, session);
					},
					onEvent: (event, payload) => {
						if (settled || callbackError !== undefined || event.kind !== "output") return;
						const text = Buffer.from(payload.buffer, payload.byteOffset, payload.length).toString("utf8");
						if (!text || options?.onOutput === undefined) return;
						const info: ShellOutputInfo = { stream: event.stream === "stderr" ? "stderr" : "stdout" };
						if (event.skipped !== undefined) info.skipped = event.skipped as ShellOutputSkip;
						try {
							options.onOutput(text, context, info);
						} catch (error) {
							const cause = error instanceof Error ? error : new Error(String(error));
							callbackError = new ExecutionError("callback_error", cause.message, cause);
							abort.abort();
						}
					},
				},
			);
			return callbackError
				? err(callbackError)
				: ok({
						exitCode: json.exitCode as number,
						...(typeof json.spillPath === "string" ? { spillPath: json.spillPath } : {}),
					});
		} catch (error) {
			if (callbackError) return err(callbackError);
			if (!(error instanceof RemoteError))
				return err(new ExecutionError("unknown", error instanceof Error ? error.message : String(error)));
			const code =
				error.code === "timeout" ||
				error.code === "aborted" ||
				error.code === "shell_unavailable" ||
				error.code === "spawn_error"
					? error.code
					: "unknown";
			const failure = new ExecutionError(
				code,
				code === "timeout" ? `timeout:${timeout}` : code === "aborted" ? "aborted" : error.message,
			);
			if (typeof error.fields.spillPath === "string") failure.spillPath = error.fields.spillPath;
			return err(failure);
		} finally {
			settled = true;
			signal?.removeEventListener("abort", cancel);
			if (requestId !== undefined) this.#running.delete(requestId);
		}
	}
	async cleanup(_context: Context): Promise<void> {
		for (const [id, session] of this.#running) this.connection.kill(id, session);
		this.#running.clear();
	}
}
