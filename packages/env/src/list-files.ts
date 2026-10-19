import type { Context } from "@axi/chord";
import {
	err,
	FileError,
	ok,
	type FileKind,
	type FileListing,
	type ListFilesOptions,
	type Result,
} from "@axi/durable/env";
import { NodeExecutionEnv } from "@axi/durable/env/node";
import type { Connection } from "./connection.ts";
import { abortResult, toFileError } from "./errors.ts";

const kinds: Record<number, FileKind> = { 102: "file", 100: "directory", 108: "symlink" };

export async function listFilesOver(
	connection: Connection,
	path: string,
	options: ListFilesOptions | undefined,
	context: Context,
): Promise<Result<FileListing, FileError>> {
	for (const field of ["maxEntries", "maxBytes", "timeoutMs"] as const) {
		const value = options?.[field];
		if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
			return err(new FileError("invalid", `${field} must be a non-negative safe integer`, path));
	}
	const before = abortResult<FileListing>(context.abortSignal, path);
	if (before) return before;
	try {
		if (!(await connection.info()).features?.includes("listFiles"))
			return err(
				new FileError("not_supported", "This Axi environment does not support file listing; update its daemon", path),
			);
		const { json, payload } = await connection.request(
			"listFiles",
			{
				path,
				hidden: options?.hidden,
				gitignore: options?.gitignore,
				exclude: options?.exclude,
				maxEntries: options?.maxEntries,
				maxBytes: options?.maxBytes,
				timeoutMs: options?.timeoutMs,
			},
			context.abortSignal ? { signal: context.abortSignal } : {},
		);
		const after = abortResult<FileListing>(context.abortSignal, path);
		if (after) return after;
		const entries: FileListing["entries"] = [],
			bytes = Buffer.from(payload.buffer, payload.byteOffset, payload.length);
		let cursor = 0;
		while (cursor < bytes.length) {
			const end = bytes.indexOf(0, cursor);
			if (end < 0) break;
			const kind = kinds[bytes[cursor]!];
			if (kind !== undefined) entries.push({ path: bytes.toString("utf8", cursor + 1, end), kind });
			cursor = end + 1;
		}
		return ok({ entries, truncated: json.truncated === true });
	} catch (error) {
		return err(toFileError(error, path));
	}
}

export type LocalExecutionEnvOptions = ConstructorParameters<typeof NodeExecutionEnv>[0] & { connection: Connection };
export class LocalExecutionEnv extends NodeExecutionEnv {
	readonly #connection: Connection;
	constructor({ connection, ...options }: LocalExecutionEnvOptions) {
		super(options);
		this.#connection = connection;
	}
	async listFiles(
		path: string,
		options: ListFilesOptions | undefined,
		context: Context,
	): Promise<Result<FileListing, FileError>> {
		const resolved = await this.absolutePath(path, context);
		return resolved.ok ? listFilesOver(this.#connection, resolved.value, options, context) : resolved;
	}
}
