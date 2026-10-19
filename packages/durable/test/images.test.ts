import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { createNodePhotonImages } from "../src/images/node.ts";

vi.mock("node:worker_threads", () => ({
	Worker: class extends EventEmitter {
		unref() {}
		ref() {}
		postMessage({ id }: { id: number }) {
			queueMicrotask(() => this.emit("message", { id, result: undefined }));
		}
	},
}));

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
