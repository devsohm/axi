import type { Context } from "@axi/chord";

export type Result<TValue, TError> = { ok: true; value: TValue } | { ok: false; error: TError };
export const ok = <TValue, TError>(value: TValue): Result<TValue, TError> => ({ ok: true, value });
export const err = <TValue, TError>(error: TError): Result<TValue, TError> => ({ ok: false, error });
export function getOrThrow<TValue, TError>(result: Result<TValue, TError>): TValue {
	if (result.ok) return result.value;
	throw result.error;
}
export function getOrUndefined<TValue extends object, TError>(result: Result<TValue, TError>): TValue | undefined {
	return result.ok ? result.value : undefined;
}
export function toError(value: unknown): Error {
	if (value instanceof Error) return value;
	if (typeof value === "string") return new Error(value);
	try {
		return new Error(JSON.stringify(value));
	} catch {
		return new Error(String(value));
	}
}
export type FileKind = "file" | "directory" | "symlink";
export type FileErrorCode =
	| "aborted"
	| "not_found"
	| "permission_denied"
	| "not_directory"
	| "is_directory"
	| "invalid"
	| "not_supported"
	| "unknown";
export class FileError extends Error {
	public code: FileErrorCode;
	public path?: string;
	constructor(code: FileErrorCode, message: string, path?: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "FileError";
		this.code = code;
		this.path = path;
	}
}
export type ExecutionErrorCode =
	| "aborted"
	| "timeout"
	| "shell_unavailable"
	| "spawn_error"
	| "callback_error"
	| "unknown";
export class ExecutionError extends Error {
	public code: ExecutionErrorCode;
	public spillPath?: string;
	constructor(code: ExecutionErrorCode, message: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "ExecutionError";
		this.code = code;
	}
}
export interface FileInfo {
	name: string;
	path: string;
	kind: FileKind;
	size: number;
	mtimeMs: number;
}
export interface TextLine {
	text: string;
	terminated: boolean;
}
export interface TextLineReader {
	readLine(context: Context): Promise<Result<TextLine | undefined, FileError>>;
	close(context: Context): Promise<void>;
}
export interface LineScan {
	newlines: number;
	start: number;
	end: number;
	firstLineEnd: number;
	lastLineStart: number;
	selectedBytes: number;
	firstLineBytes: number;
}
export interface BinaryReader {
	info(context: Context): Promise<Result<FileInfo, FileError>>;
	read(offset: number, length: number, context: Context): Promise<Result<Uint8Array, FileError>>;
	scanLines(options: { startLine: number; endLine?: number }, context: Context): Promise<Result<LineScan, FileError>>;
	close(context: Context): Promise<void>;
}
export interface DirReader {
	next(maxEntries: number, context: Context): Promise<Result<{ entries: FileInfo[]; done: boolean }, FileError>>;
	close(context: Context): Promise<void>;
}
export interface WatchTarget {
	path: string;
	recursive?: boolean;
	exclude?: { hidden?: boolean; names?: readonly string[] };
}
export type WatchChange = { paths: string[] } | { overflow: true } | { error: FileError };
export interface FileWatcher {
	readonly mode: "native" | "polling";
	close(context: Context): Promise<void>;
}
export interface ListFilesOptions {
	hidden?: boolean;
	gitignore?: boolean;
	exclude?: readonly string[];
	maxEntries?: number;
	maxBytes?: number;
	timeoutMs?: number;
}
export interface FileListEntry {
	path: string;
	kind: FileKind;
}
export interface FileListing {
	entries: FileListEntry[];
	truncated: boolean;
}
export interface FileSystem {
	readonly id: string;
	cwd: string;
	absolutePath(path: string, context: Context): Promise<Result<string, FileError>>;
	joinPath(parts: string[], context: Context): Promise<Result<string, FileError>>;
	readTextFile(path: string, context: Context): Promise<Result<string, FileError>>;
	openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>>;
	readTextLines(
		path: string,
		options: { maxLines?: number } | undefined,
		context: Context,
	): Promise<Result<string[], FileError>>;
	readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>>;
	openBinaryReader(
		path: string,
		options: { noFollow?: boolean } | undefined,
		context: Context,
	): Promise<Result<BinaryReader, FileError>>;
	writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>>;
	appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>>;
	truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>>;
	flushFile(path: string, context: Context): Promise<Result<void, FileError>>;
	renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>>;
	fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>>;
	listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>>;
	listFiles?(
		path: string,
		options: ListFilesOptions | undefined,
		context: Context,
	): Promise<Result<FileListing, FileError>>;
	openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>>;
	watch(
		targets: readonly WatchTarget[],
		onChange: (change: WatchChange) => void,
		context: Context,
	): Promise<Result<FileWatcher, FileError>>;
	canonicalPath(path: string, context: Context): Promise<Result<string, FileError>>;
	exists(path: string, context: Context): Promise<Result<boolean, FileError>>;
	createDir(
		path: string,
		options: { recursive?: boolean } | undefined,
		context: Context,
	): Promise<Result<void, FileError>>;
	remove(
		path: string,
		options: { recursive?: boolean; force?: boolean } | undefined,
		context: Context,
	): Promise<Result<void, FileError>>;
	createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>>;
	createTempFile(
		options: { prefix?: string; suffix?: string } | undefined,
		context: Context,
	): Promise<Result<string, FileError>>;
	cleanup(context: Context): Promise<void>;
}
export interface ShellSpillOptions {
	afterBytes: number;
	afterLines: number;
}
export interface ShellExecResult {
	exitCode: number;
	spillPath?: string;
}
export interface ShellOutputWindow {
	maxBytes: number;
	maxLines: number;
	minIntervalMs: number;
	bytesPerSecond: number;
}
export interface ShellOutputSkip {
	bytes: number;
	newlines: number;
	endsWithNewline: boolean;
}
export interface ShellOutputInfo {
	stream: "stdout" | "stderr";
	skipped?: ShellOutputSkip;
}
export interface ShellExecOptions {
	cwd?: string;
	env?: Record<string, string>;
	inheritEnv?: boolean;
	timeout?: number;
	onOutput?: (text: string, context: Context, info: ShellOutputInfo) => void;
	spill?: ShellSpillOptions;
	window?: ShellOutputWindow;
}
export interface Shell {
	exec(
		command: string | readonly string[],
		options: ShellExecOptions | undefined,
		context: Context,
	): Promise<Result<ShellExecResult, ExecutionError>>;
	cleanup(context: Context): Promise<void>;
}
export interface ExecutionEnv extends FileSystem, Shell {}
export { rangeDecoder, startsWithBom, StreamDecoder } from "./decode.ts";
export { LineScanner } from "./line-scan.ts";
