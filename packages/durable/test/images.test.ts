import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PhotonImage } from "@silvia-odwyer/photon/photon_rs.js";
import { createNodePhotonImages } from "../src/images/node.ts";

const backend = vi.hoisted((): { startError?: Error; reply: boolean; workers: EventEmitter[] } => ({
	reply: true,
	workers: [],
}));
vi.mock("node:worker_threads", () => ({
	Worker: class extends EventEmitter {
		constructor() {
			super();
			if (backend.startError) throw backend.startError;
			backend.workers.push(this);
		}
		unref() {}
		ref() {}
		postMessage({ id }: { id: number }) {
			if (backend.reply) queueMicrotask(() => this.emit("message", { id, result: undefined }));
		}
		async terminate() {
			this.emit("exit", 0);
			return 0;
		}
	},
}));

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.restoreAllMocks();
	vi.clearAllTimers();
	vi.useRealTimers();
	delete backend.startError;
	backend.reply = true;
	backend.workers.length = 0;
});
const limits = { maxWidth: 8, maxHeight: 8, maxBytes: 10_000 };

it("captures the image worker idle timeout when the processor is created", async () => {
	const options = { idleMs: 17 };
	const images = await createNodePhotonImages(options);
	options.idleMs = 99;
	const timer = vi.spyOn(globalThis, "setTimeout");
	try {
		await images.prepare(new Uint8Array(), "image/png", { maxWidth: 100, maxHeight: 100, maxBytes: 100 });
		expect(timer).toHaveBeenCalledWith(expect.any(Function), 17);
	} finally {
		for (const result of timer.mock.results) if (result.type === "return") clearTimeout(result.value);
		timer.mockRestore();
	}
});

it.each(["constructor", "startup-event"])("uses direct image preparation after a worker %s failure", async (mode) => {
	await createNodePhotonImages({ worker: false });
	const pixel = new PhotonImage(new Uint8Array([40, 80, 120, 255]), 1, 1);
	try {
		const bytes = pixel.get_bytes();
		const expected = { data: Buffer.from(bytes).toString("base64"), mimeType: "image/png" };
		if (mode === "constructor") backend.startError = new Error("Workers unavailable");
		else backend.reply = false;
		const images = await createNodePhotonImages();
		const first = images.prepare(bytes, "image/png", limits);
		if (mode === "startup-event") backend.workers[0]!.emit("error", new Error("Worker entry unavailable"));
		expect(await first).toEqual(expected);
		delete backend.startError;
		backend.reply = true;
		expect(await images.prepare(bytes, "image/png", limits)).toEqual(expected);
	} finally {
		pixel.free();
	}
});

it.each(["error", "exit"])("rejects all pending images after an established worker %s", async (event) => {
	const images = await createNodePhotonImages();
	await images.prepare(new Uint8Array(), "image/png", limits);
	backend.reply = false;
	const first = images.prepare(new Uint8Array(), "image/png", limits);
	const second = images.prepare(new Uint8Array(), "image/png", limits);
	const rejected = Promise.allSettled([first, second]);
	const error = new Error("Worker lost");
	backend.workers[0]!.emit(event, event === "error" ? error : 7);
	const results = await rejected;
	for (const result of results) {
		expect(result.status).toBe("rejected");
		if (result.status !== "rejected") throw new Error("A lost worker resolved its image");
		if (event === "error") expect(result.reason).toBe(error);
		else expect(result.reason.message).toBe("The Photon image worker exited with code 7");
	}
	backend.reply = true;
	expect(await images.prepare(new Uint8Array(), "image/png", limits)).toBeUndefined();
});

it("rejects one image response without discarding the worker or another pending response", async () => {
	backend.reply = false;
	const images = await createNodePhotonImages({ idleMs: 10 });
	const first = images.prepare(new Uint8Array(), "image/png", limits);
	const second = images.prepare(new Uint8Array(), "image/png", limits);
	const rejected = expect(first).rejects.toThrow("Image could not be decoded");
	const worker = backend.workers[0]!;
	worker.emit("message", { id: 999, result: undefined });
	worker.emit("message", { id: 0, error: "Image could not be decoded" });
	worker.emit("message", { id: 1, result: { data: "AQ==", mimeType: "image/png" } });
	await rejected;
	expect(await second).toEqual({ data: "AQ==", mimeType: "image/png" });
	await vi.advanceTimersByTimeAsync(10);
	backend.reply = true;
	expect(await images.prepare(new Uint8Array(), "image/png", limits)).toBeUndefined();
});
