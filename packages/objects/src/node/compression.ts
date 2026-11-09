import { constants } from "node:buffer";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import type { Compression } from "../link/index.ts";

export const nodeCompression: Compression = {
	deflate(bytes) {
		return deflateRawSync(bytes, { level: 1 });
	},
	inflate(bytes, limit) {
		try {
			const result = inflateRawSync(bytes, { maxOutputLength: Math.min(constants.MAX_LENGTH, Math.max(1, limit)) });
			return result.byteLength <= limit ? { kind: "bytes", bytes: result } : { kind: "too_large" };
		} catch (error) {
			return error !== null && typeof error === "object" && "code" in error && error.code === "ERR_BUFFER_TOO_LARGE"
				? { kind: "too_large" }
				: { kind: "corrupt", error };
		}
	},
};
