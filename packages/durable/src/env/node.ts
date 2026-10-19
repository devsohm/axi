import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	appendFile,
	lstat,
	mkdir,
	mkdtemp,
	open,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "@axi/chord";
import {
	type BinaryReader,
	type DirReader,
	type ExecutionEnv,
	type ExecutionError,
	err,
	FileError,
	type FileInfo,
	type FileWatcher,
	ok,
	type Result,
	type ShellExecOptions,
	type ShellExecResult,
	type TextLineReader,
	type WatchChange,
	type WatchTarget,
} from "./index.ts";
import { checkFileContext, describeFile, fileOperation, openBytes, openDirectory, openLines } from "./node-files.ts";
import { runCommand, terminate } from "./node-shell.ts";
import { NodeFileWatcher, type NodeWatchOptions } from "./node-watch.ts";

export type { NodeWatchOptions } from "./node-watch.ts";

export class NodeExecutionEnv implements ExecutionEnv {
	readonly id: string = "node:local";
	cwd: string;
	private readonly shellPath: string | undefined;
	private readonly shellEnv: NodeJS.ProcessEnv | undefined;
	private readonly watchOptions: NodeWatchOptions;
	private readonly processes = new Set<ChildProcess>();
	constructor(options: { cwd: string; shellPath?: string; shellEnv?: NodeJS.ProcessEnv; watch?: NodeWatchOptions }) {
		this.cwd = options.cwd;
		this.shellPath = options.shellPath;
		this.shellEnv = options.shellEnv;
		this.watchOptions = options.watch ?? {};
	}
	private resolvePath(path: string): string {
		if (path.startsWith("file://")) {
			try {
				path = fileURLToPath(path);
			} catch {}
		}
		if (path === "~") path = homedir();
		else if (path.startsWith("~/") || (process.platform === "win32" && path.startsWith("~\\")))
			path = join(homedir(), path.slice(2));
		return normalize(resolve(this.cwd, path));
	}
	absolutePath(path: string, _context: Context): Promise<Result<string, FileError>> {
		return Promise.resolve(ok(this.resolvePath(path)));
	}
	joinPath(parts: string[], _context: Context): Promise<Result<string, FileError>> {
		return Promise.resolve(ok(join(...parts)));
	}
	readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
		const target = this.resolvePath(path);
		return fileOperation(target, context, () => readFile(target, { encoding: "utf8", signal: context.abortSignal }));
	}
	readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
		const target = this.resolvePath(path);
		return fileOperation(target, context, () => readFile(target, { signal: context.abortSignal }));
	}
	openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
		return openLines(this.resolvePath(path), context);
	}
	async readTextLines(
		path: string,
		options: { maxLines?: number } | undefined,
		context: Context,
	): Promise<Result<string[], FileError>> {
		if (options?.maxLines !== undefined && options.maxLines <= 0) return ok([]);
		const result = await this.openTextLineReader(path, context);
		if (!result.ok) return result;
		const reader = result.value;
		const lines: string[] = [];
		try {
			while (options?.maxLines === undefined || lines.length < options.maxLines) {
				const line = await reader.readLine(context);
				if (!line.ok) return line;
				if (line.value === undefined) break;
				lines.push(line.value.text);
			}
			return ok(lines);
		} finally {
			await reader.close(context);
		}
	}
	openBinaryReader(
		path: string,
		options: { noFollow?: boolean } | undefined,
		context: Context,
	): Promise<Result<BinaryReader, FileError>> {
		return openBytes(this.resolvePath(path), options?.noFollow === true, context);
	}
	writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		const target = this.resolvePath(path);
		return fileOperation(target, context, async () => {
			await mkdir(dirname(target), { recursive: true });
			checkFileContext(context, target);
			await writeFile(target, content, { signal: context.abortSignal });
		});
	}
	appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		const target = this.resolvePath(path);
		return fileOperation(target, context, async () => {
			await mkdir(dirname(target), { recursive: true });
			checkFileContext(context, target);
			await appendFile(target, content);
			checkFileContext(context, target);
		});
	}
	truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>> {
		const target = this.resolvePath(path);
		return fileOperation(target, context, async () => {
			if (!Number.isSafeInteger(size) || size < 0)
				throw new FileError("invalid", "File size must be a non-negative safe integer", target);
			const handle = await open(target, "r+");
			try {
				await handle.truncate(size);
				checkFileContext(context, target);
			} finally {
				await handle.close().catch(() => {});
			}
		});
	}
	flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
		const target = this.resolvePath(path);
		return fileOperation(target, context, async () => {
			const handle = await open(target, "r+");
			try {
				if ((await handle.stat()).isDirectory()) throw new FileError("is_directory", "Is a directory", target);
				await handle.sync();
				checkFileContext(context, target);
			} finally {
				await handle.close().catch(() => {});
			}
		});
	}
	renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> {
		const source = this.resolvePath(sourcePath),
			destination = this.resolvePath(destinationPath);
		if (context.abortSignal?.aborted) return Promise.resolve(err(new FileError("aborted", "aborted", destination)));
		return fileOperation(source, context, () => rename(source, destination));
	}
	fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
		const target = this.resolvePath(path);
		return fileOperation(target, context, async () => {
			const info = describeFile(target, await lstat(target));
			if (!info) throw new FileError("invalid", "Unsupported file type", target);
			return info;
		});
	}
	listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
		const target = this.resolvePath(path);
		return fileOperation(target, context, async () => {
			const files: FileInfo[] = [];
			for (const name of await readdir(target)) {
				checkFileContext(context, target);
				const info = describeFile(join(target, name), await lstat(join(target, name)));
				if (info) files.push(info);
			}
			return files;
		});
	}
	openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
		return openDirectory(this.resolvePath(path), context);
	}
	watch(
		targets: readonly WatchTarget[],
		onChange: (change: WatchChange) => void,
		context: Context,
	): Promise<Result<FileWatcher, FileError>> {
		return fileOperation(undefined, context, async () => {
			const watcher = await NodeFileWatcher.open(
				targets,
				(path) => this.resolvePath(path),
				onChange,
				this.watchOptions,
			);
			if (context.abortSignal?.aborted) {
				await watcher.close(context);
				checkFileContext(context, undefined);
			}
			return watcher;
		});
	}
	canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
		const target = this.resolvePath(path);
		return fileOperation(target, context, () => realpath(target));
	}
	async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
		const result = await this.fileInfo(path, context);
		if (result.ok) return ok(true);
		return result.error.code === "not_found" ? ok(false) : result;
	}
	createDir(
		path: string,
		options: { recursive?: boolean } | undefined,
		context: Context,
	): Promise<Result<void, FileError>> {
		const target = this.resolvePath(path);
		return fileOperation(target, context, async () => {
			await mkdir(target, { recursive: options?.recursive ?? true });
		});
	}
	remove(
		path: string,
		options: { recursive?: boolean; force?: boolean } | undefined,
		context: Context,
	): Promise<Result<void, FileError>> {
		const target = this.resolvePath(path);
		return fileOperation(target, context, () =>
			rm(target, { recursive: options?.recursive ?? false, force: options?.force ?? false }),
		);
	}
	createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
		return fileOperation(undefined, context, () => mkdtemp(join(tmpdir(), prefix ?? "tmp-")));
	}
	async createTempFile(
		options: { prefix?: string; suffix?: string } | undefined,
		context: Context,
	): Promise<Result<string, FileError>> {
		const directory = await this.createTempDir("tmp-", context);
		if (!directory.ok) return directory;
		const target = join(directory.value, `${options?.prefix ?? ""}${randomUUID()}${options?.suffix ?? ""}`);
		return fileOperation(target, context, async () => {
			await writeFile(target, "");
			return target;
		});
	}
	exec(
		command: string | readonly string[],
		options: ShellExecOptions | undefined,
		context: Context,
	): Promise<Result<ShellExecResult, ExecutionError>> {
		return runCommand(
			{
				shellPath: this.shellPath,
				shellEnv: this.shellEnv,
				resolve: (path) => this.resolvePath(path),
				createTempFile: (options, context) => this.createTempFile(options, context),
				processes: this.processes,
			},
			command,
			options,
			context,
		);
	}
	async cleanup(_context: Context): Promise<void> {
		for (const child of this.processes) terminate(child);
		this.processes.clear();
	}
}
