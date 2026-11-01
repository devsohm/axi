import { err, FileError, type Result } from "@axi/durable/env";
import { RemoteError } from "./connection.ts";

export function abortResult<T>(signal: AbortSignal | undefined, path?: string): Result<T, FileError> | undefined {
	return signal?.aborted ? err(new FileError("aborted", "aborted", path)) : undefined;
}
export function toFileError(error: unknown, fallback?: string): FileError {
	if (error instanceof FileError) return error;
	if (!(error instanceof RemoteError)) {
		const cause = error instanceof Error ? error : new Error(String(error));
		return new FileError("unknown", cause.message, fallback, cause);
	}
	const path = error.path ?? fallback;
	let code: FileError["code"] = "unknown";
	switch (error.code) {
		case "aborted":
			code = "aborted";
			break;
		case "ENOENT":
			code = "not_found";
			break;
		case "EACCES":
		case "EPERM":
			code = "permission_denied";
			break;
		case "ENOTDIR":
			code = "not_directory";
			break;
		case "EISDIR":
			code = "is_directory";
			break;
		case "EINVAL":
		case "SYMLINK":
		case "NOT_REGULAR":
			code = "invalid";
			break;
	}
	return new FileError(code, error.message, path, error);
}
