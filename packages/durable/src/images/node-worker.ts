import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { parentPort } from "node:worker_threads";
import type { ImageLimits, PreparedImage } from "../tools/image-processor.ts";
import { createPhotonImages } from "./index.ts";

export type PrepareRequest = {
	readonly id: number;
	readonly bytes: Uint8Array;
	readonly mimeType: string;
	readonly limits: ImageLimits;
};
export type PrepareReply =
	| { readonly id: number; readonly result: PreparedImage | undefined }
	| { readonly id: number; readonly error: string };
const port = parentPort;
if (port === null) throw new Error("The Photon image worker needs a parent thread");
const processor = createPhotonImages(
	readFileSync(createRequire(import.meta.url).resolve("@silvia-odwyer/photon/photon_rs_bg.wasm")),
);
port.on("message", ({ id, bytes, mimeType, limits }: PrepareRequest) => {
	void processor.prepare(bytes, mimeType, limits).then(
		(result) => port.postMessage({ id, result } satisfies PrepareReply),
		(error: unknown) =>
			port.postMessage({ id, error: error instanceof Error ? error.message : String(error) } satisfies PrepareReply),
	);
});
