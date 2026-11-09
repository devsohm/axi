import type { Context } from "../context/index.ts";

export type FileResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: Error };
export type SyncFileInfo = { readonly name: string; readonly kind: "file" | "directory" | "symlink" };
export interface SyncFileReader {
	read(offset: number, length: number, context: Context): Promise<FileResult<Uint8Array>>;
	close(context: Context): Promise<void>;
}
export interface SyncFileSystem {
	joinPath(parts: string[], context: Context): Promise<FileResult<string>>;
	readTextFile(path: string, context: Context): Promise<FileResult<string>>;
	readBinaryFile(path: string, context: Context): Promise<FileResult<Uint8Array>>;
	openBinaryReader(
		path: string,
		options: { noFollow?: boolean } | undefined,
		context: Context,
	): Promise<FileResult<SyncFileReader>>;
	writeFile(path: string, content: string | Uint8Array, context: Context): Promise<FileResult<void>>;
	appendFile(path: string, content: string | Uint8Array, context: Context): Promise<FileResult<void>>;
	renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<FileResult<void>>;
	listDir(path: string, context: Context): Promise<FileResult<SyncFileInfo[]>>;
	createDir(path: string, options: { recursive?: boolean } | undefined, context: Context): Promise<FileResult<void>>;
	remove(
		path: string,
		options: { recursive?: boolean; force?: boolean } | undefined,
		context: Context,
	): Promise<FileResult<void>>;
}
export function isNotFound(result: FileResult<unknown>): boolean {
	return !result.ok && "code" in result.error && result.error.code === "not_found";
}
export function unwrap<T>(result: FileResult<T>): T {
	if (result.ok) return result.value;
	throw result.error;
}
