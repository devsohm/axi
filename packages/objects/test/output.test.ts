import { afterEach, describe, expect, it, vi } from "vitest";
import { boundOutput, OutputBuffer, Progress, sanitizeOutput, utf8ByteLength } from "../src/output.ts";

afterEach(() => vi.useRealTimers());

describe("bounded output", () => {
	it("measures UTF-8 without splitting code points when cutting", () => {
		expect(utf8ByteLength("aé🙂\ud800")).toBe(10);
		expect(boundOutput("é🙂", { maxBytes: 5, maxLines: 1, retain: "head" })).toEqual({
			text: "é",
			bytes: 2,
			droppedBytes: 4,
			droppedLines: 0,
		});
		expect(boundOutput("é🙂", { maxBytes: 5, maxLines: 1, retain: "tail" })).toEqual({
			text: "🙂",
			bytes: 4,
			droppedBytes: 2,
			droppedLines: 0,
		});
	});

	it("selects complete lines before sanitizing control characters", () => {
		const stream = new OutputBuffer({ maxBytes: 50, maxLines: 1, retain: "tail" });
		stream.push("hidden\n");
		stream.push("x\u001b\t\ny\u0000");
		expect(stream.snapshot()).toEqual({ text: "y", droppedBytes: 11, droppedLines: 2 });
		expect(sanitizeOutput("a\r\nb\t\u007fc")).toBe("a\nb\t\u007fc");
	});

	it("flushes incomplete bytes before strings and removes only the first byte-order mark", () => {
		const stream = new OutputBuffer({ maxBytes: 100, maxLines: 10, retain: "tail" });
		expect(stream.push(new Uint8Array([239]))).toBe(false);
		stream.push(new Uint8Array([187, 191, 226]));
		stream.push("done");
		stream.push(new TextEncoder().encode("\ufeff"));
		stream.end();
		expect(stream.snapshot()).toEqual({ text: "\ufffddone\ufeff", droppedBytes: 0, droppedLines: 0 });
	});

	it("preserves preceding line counts when a producer omits output", () => {
		const stream = new OutputBuffer({ maxBytes: 20, maxLines: 1, retain: "tail" });
		stream.push("visible\n", { bytes: 30, newlines: 4, endsWithNewline: true });
		expect(stream.snapshot()).toEqual({ text: "visible\n", droppedBytes: 30, droppedLines: 4 });
	});

	it("keeps storage bounded across frequent snapshots", () => {
		const stream = new OutputBuffer({ maxBytes: 20, maxLines: 1, retain: "tail" });
		for (let i = 0; i < 100; i++) {
			stream.push("line\n");
			stream.snapshot();
		}
		expect(stream.snapshot()).toEqual({ text: "line\n", droppedBytes: 495, droppedLines: 99 });
		expect(stream.storedBytes).toBeLessThanOrEqual(20);
	});
});

describe("progress commits", () => {
	it("settles an idle stop after the existing microtask turn", async () => {
		const progress = new Progress(
			async () => 0,
			() => {},
			0,
		);
		const events: string[] = [];
		const stopped = progress.stop().then(() => events.push("stopped"));
		queueMicrotask(() => {
			events.push("first");
			queueMicrotask(() => events.push("second"));
		});
		await stopped;
		await Promise.resolve();
		expect(events).toEqual(["first", "stopped", "second"]);
	});

	it("serializes writes and returns queued waiters for a final shutdown commit", async () => {
		const writing = Promise.withResolvers<number>();
		let writes = 0;
		const progress = new Progress(
			() => {
				writes++;
				return writing.promise;
			},
			() => {},
			0,
		);
		const first = progress.markAndWait();
		const queued = progress.markAndWait();
		const stopping = progress.stop();
		writing.resolve(0);
		await first;
		const remaining = await stopping;
		expect(writes).toBe(1);
		expect(remaining).toHaveLength(1);
		remaining[0].resolve();
		await queued;
		expect(await progress.stop()).toEqual([]);
	});

	it("coalesces changes until the size-dependent next deadline", async () => {
		vi.useFakeTimers({ now: 1000 });
		const times: number[] = [];
		const progress = new Progress(
			async () => {
				times.push(Date.now());
				return 25 * 1024;
			},
			() => {},
			10,
		);
		progress.mark();
		await vi.advanceTimersByTimeAsync(0);
		progress.mark();
		progress.mark();
		await vi.advanceTimersByTimeAsync(249);
		expect(times).toEqual([1000]);
		await vi.advanceTimersByTimeAsync(1);
		expect(times).toEqual([1000, 1250]);
		await progress.stop();
	});
});
