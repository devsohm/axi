import { afterEach, expect, test, vi } from "vitest";
import { boundOutput, OutputBuffer, Progress, sanitizeOutput } from "../src/output.ts";

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

test("output byte measurement works in runtimes without the Node Buffer global", async () => {
	vi.resetModules();
	vi.stubGlobal("Buffer", undefined);
	try {
		const { utf8ByteLength } = await import("../src/output.ts");
		for (const [text, bytes] of [
			["", 0],
			["ASCII", 5],
			["aé界🙂z", 11],
			["\ud800a\udc00", 7],
			["\ud800", 3],
			["\ufeff", 3],
		] as const)
			expect(utf8ByteLength(text)).toBe(bytes);
	} finally {
		vi.unstubAllGlobals();
		vi.resetModules();
	}
});

test("sanitization removes complete terminal controls while retaining surrounding text and printable incomplete payloads", () => {
	for (const [input, expected] of [
		["a\x1b[31mred\x1b[0mz", "aredz"],
		["a\x1b[?25lhidden\x1b[?25hz", "ahiddenz"],
		["a\x1b]0;title\x07z", "az"],
		["a\x1b]8;;https://example.invalid\x1b\\link\x1b]8;;\x1b\\z", "alinkz"],
		["a\x1bPpayload\x1b\\z", "az"],
		["a\x1bXpayload\x07z", "az"],
		["a\x1b^payload\x1b\\z", "az"],
		["a\x1b_payload\x07z", "az"],
		["a\x1b(0line\x1b(Bz", "alinez"],
		["a\x1b", "a"],
		["a\x1b[31", "a31"],
		["a\x1b]unfinished", "aunfinished"],
		["a\x00\x08\x0b\x1f\ufff9\ufffa\ufffb\tz\n", "a\tz\n"],
	] as const)
		expect(sanitizeOutput(input), JSON.stringify(input)).toBe(expected);
});

test.each(["head", "tail"] as const)("%s retention honors zero limits and counts an unterminated line", (retain) => {
	for (const limits of [
		{ maxBytes: 0, maxLines: 5 },
		{ maxBytes: 100, maxLines: 0 },
	]) {
		expect(boundOutput("é\nlast", { ...limits, retain })).toEqual({
			text: "",
			bytes: 0,
			droppedBytes: 7,
			droppedLines: 2,
		});
		expect(boundOutput("", { ...limits, retain })).toEqual({ text: "", bytes: 0, droppedBytes: 0, droppedLines: 0 });
	}
});

test("head retention stops on complete line boundaries and accounts for later discarded chunks", () => {
	const output = new OutputBuffer({ maxBytes: 8, maxLines: 2, retain: "head" });
	for (const chunk of ["one\n", "two\n", "three\n", "last"]) output.push(chunk);
	expect(output.snapshot()).toEqual({ text: "one\ntwo\n", droppedBytes: 10, droppedLines: 2 });
	expect(output.storedBytes).toBe(8);
	expect(() => output.push("next", { bytes: 2, newlines: 0, endsWithNewline: false })).toThrow(/tail retention/);
});

test("tail retention keeps complete lines when possible and otherwise keeps whole UTF-8 characters", () => {
	for (const [input, maxBytes, expected] of [
		["aa\nbbb\ncc", 7, "bbb\ncc"],
		["aa\nbbb\ncc", 5, "cc"],
		["é🙂", 3, ""],
		["é🙂", 4, "🙂"],
		["a\n", 1, "\n"],
		["\n", 4, "\n"],
	] as const) {
		const output = new OutputBuffer({ maxBytes, maxLines: 10, retain: "tail" });
		for (const byte of new TextEncoder().encode(input)) {
			output.push(new Uint8Array([byte]));
			output.snapshot();
		}
		output.end();
		expect(output.snapshot().text, JSON.stringify(input)).toBe(expected);
		expect(output.snapshot().droppedBytes).toBe(Buffer.byteLength(input) - Buffer.byteLength(expected));
	}
});

test("empty skip markers retain prior output and an actual skip resets only the retained tail", () => {
	const output = new OutputBuffer({ maxBytes: 20, maxLines: 3, retain: "tail" });
	output.push("before\n");
	output.push("after", { bytes: 0, newlines: 0, endsWithNewline: true });
	expect(output.snapshot()).toEqual({ text: "before\nafter", droppedBytes: 0, droppedLines: 0 });
	output.push("tail\n", { bytes: 10, newlines: 2, endsWithNewline: true });
	expect(output.snapshot()).toEqual({ text: "tail\n", droppedBytes: 22, droppedLines: 3 });
});

test("a failed progress write rejects its callers, reports once and permits a later successful batch", async () => {
	vi.useFakeTimers({ now: 1000 });
	const failure = new Error("Progress write failed"),
		reports: unknown[] = [];
	let writes = 0;
	const progress = new Progress(
		async () => {
			if (++writes === 1) throw failure;
			return 0;
		},
		(error) => reports.push(error),
		25,
	);
	await expect(progress.markAndWait()).rejects.toBe(failure);
	expect(reports).toEqual([failure]);
	const first = progress.markAndWait(),
		second = progress.markAndWait();
	await vi.advanceTimersByTimeAsync(24);
	expect(writes).toBe(1);
	await vi.advanceTimersByTimeAsync(1);
	await Promise.all([first, second]);
	expect(writes).toBe(2);
	expect(reports).toEqual([failure]);
	expect(await progress.stop()).toEqual([]);
});

test("stopping progress cancels its delayed flush and returns pending callers for final persistence", async () => {
	vi.useFakeTimers({ now: 1000 });
	let writes = 0;
	const progress = new Progress(
		async () => {
			writes++;
			return 0;
		},
		() => {},
		100,
	);
	await progress.markAndWait();
	const pending = progress.markAndWait(),
		waiters = await progress.stop();
	await vi.advanceTimersByTimeAsync(1000);
	expect(writes).toBe(1);
	expect(waiters).toHaveLength(1);
	waiters[0]!.resolve();
	await pending;
	expect(await progress.stop()).toEqual([]);
});
