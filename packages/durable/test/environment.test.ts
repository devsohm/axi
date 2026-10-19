import { expect, it } from "vitest";
import {
	err,
	FileError,
	getOrThrow,
	getOrUndefined,
	LineScanner,
	ok,
	StreamDecoder,
	toError,
} from "../src/env/index.ts";
import { truncateHeadOf } from "../src/truncate.ts";

it("retains a byte-order mark on a selected later line across one-byte chunks", () => {
	const scan = new LineScanner(1, 2);
	const bytes = Uint8Array.of(239, 187, 191, 97, 195, 10, 239, 187, 191, 97, 10, 120);
	for (const byte of bytes) scan.push(Uint8Array.of(byte));
	expect(scan.finish()).toEqual({
		newlines: 2,
		start: 6,
		end: 10,
		firstLineEnd: 10,
		lastLineStart: 6,
		selectedBytes: 4,
		firstLineBytes: 4,
	});
});
it("preserves an interior byte-order mark after incomplete UTF-8", () => {
	const decoder = new StreamDecoder();
	let text = "";
	for (const byte of [226, 130, 239, 187, 191, 97]) text += decoder.decode(Uint8Array.of(byte));
	expect(text + decoder.decode()).toBe("\ufffd\ufeffa");
});
it("truncates a sufficient prefix using totals of the complete file", () => {
	expect(truncateHeadOf("one\ntwo\nthree\nfour", { lines: 100, bytes: 1000 }, { maxLines: 2, maxBytes: 100 })).toEqual({
		content: "one\ntwo",
		truncated: true,
		truncatedBy: "lines",
		totalLines: 100,
		totalBytes: 1000,
		outputLines: 2,
		outputBytes: 7,
		lastLinePartial: false,
		firstLineExceedsLimit: false,
		maxLines: 2,
		maxBytes: 100,
	});
});
it("preserves filesystem failure identity and returns successful values", () => {
	const failure = new FileError("not_found", "Missing file", "/missing", new Error("Cause"));
	expect(() => getOrThrow(err(failure))).toThrow(failure);
	expect(toError(failure)).toBe(failure);
	expect(failure).toMatchObject({ code: "not_found", path: "/missing", cause: { message: "Cause" } });
	expect(getOrUndefined(err<object, FileError>(failure))).toBeUndefined();
	expect(getOrThrow(ok(17))).toBe(17);
	expect(getOrUndefined(ok({ value: 17 }))).toEqual({ value: 17 });
	expect(toError({ status: 404 }).message).toBe('{"status":404}');
});
