import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import type { ImageLimits, ImageProcessor, PreparedImage } from "../tools/image-processor.ts";
import { createPhotonImages } from "./index.ts";
import type { PrepareReply, PrepareRequest } from "./node-worker.ts";

export type NodePhotonImagesOptions = { readonly worker?: boolean; readonly idleMs?: number };
class WorkerUnavailable extends Error {}

async function inline(): Promise<ImageProcessor> {
	return createPhotonImages(
		await readFile(createRequire(import.meta.url).resolve("@silvia-odwyer/photon/photon_rs_bg.wasm")),
	);
}

class ImageWorker {
	readonly worker: Worker;
	readonly pending = new Map<number, PromiseWithResolvers<PreparedImage | undefined>>();
	readonly idleMs: number;
	readonly onExit: () => void;
	private next = 0;
	private answered = false;
	private timer: ReturnType<typeof setTimeout> | undefined;
	constructor(idleMs: number, onExit: () => void) {
		this.idleMs = idleMs;
		this.onExit = onExit;
		try {
			this.worker = new Worker(
				new URL(import.meta.url.endsWith(".ts") ? "./node-worker.ts" : "./node-worker.js", import.meta.url),
			);
		} catch (error) {
			throw new WorkerUnavailable("The Photon image worker cannot start", { cause: error });
		}
		this.worker.unref();
		this.worker.on("message", (reply: PrepareReply) => {
			this.answered = true;
			const request = this.pending.get(reply.id);
			if (!request) return;
			this.pending.delete(reply.id);
			if ("error" in reply) request.reject(new Error(reply.error));
			else request.resolve(reply.result);
			if (this.pending.size === 0) {
				this.worker.unref();
				this.timer = setTimeout(() => {
					this.exit();
					void this.worker.terminate();
				}, this.idleMs);
				this.timer.unref();
			}
		});
		const failed = (error: unknown) => {
			const reason = this.answered
				? error
				: new WorkerUnavailable("The Photon image worker cannot start", { cause: error });
			for (const request of this.pending.values()) request.reject(reason);
			this.pending.clear();
			this.exit();
		};
		this.worker.on("error", failed);
		this.worker.on("exit", (code) => failed(new Error(`The Photon image worker exited with code ${code}`)));
	}
	private exit(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
		this.onExit();
	}
	prepare(bytes: Uint8Array, mimeType: string, limits: ImageLimits): Promise<PreparedImage | undefined> {
		const id = this.next++;
		const reply = Promise.withResolvers<PreparedImage | undefined>();
		this.pending.set(id, reply);
		clearTimeout(this.timer);
		this.timer = undefined;
		this.worker.ref();
		const copy = bytes.slice();
		this.worker.postMessage({ id, bytes: copy, mimeType, limits } satisfies PrepareRequest, [copy.buffer]);
		return reply.promise;
	}
}

export async function createNodePhotonImages(options: NodePhotonImagesOptions = {}): Promise<ImageProcessor> {
	if (options.worker === false) return inline();
	const idleMs = options.idleMs ?? 30_000;
	let worker: ImageWorker | undefined;
	let fallback: Promise<ImageProcessor> | undefined;
	return {
		async prepare(bytes, mimeType, limits) {
			if (fallback !== undefined) return (await fallback).prepare(bytes, mimeType, limits);
			try {
				worker ??= new ImageWorker(idleMs, () => {
					worker = undefined;
				});
				return await worker.prepare(bytes, mimeType, limits);
			} catch (error) {
				if (!(error instanceof WorkerUnavailable)) throw error;
				fallback = inline();
				return (await fallback).prepare(bytes, mimeType, limits);
			}
		},
	};
}
