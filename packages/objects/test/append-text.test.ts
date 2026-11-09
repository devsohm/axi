import { expect, it } from "vitest";
import { appendText, applyImmutable, track } from "../src/delta/index.ts";

it("publishes joined text chunks without replacing the previous revision", () => {
	const tracker = track({ blocks: [{ text: "start", count: 0 }] });
	const previous = tracker.value;
	const change = tracker.beginChange();
	appendText(change.state.blocks[0], "text", " one");
	appendText(change.state.blocks[0], "text", " two");
	change.state.blocks[0].count = 2;
	const prepared = change.prepare();
	expect(prepared.ops).toEqual([
		["a", ["blocks", 0, "text"], " one two"],
		["s", ["blocks", 0, "count"], 2],
	]);
	tracker.adopt(prepared);
	expect(tracker.value).toEqual({ blocks: [{ text: "start one two", count: 2 }] });
	expect(previous).toEqual({ blocks: [{ text: "start", count: 0 }] });
	expect(applyImmutable(previous, prepared.ops)).toEqual(tracker.value);
});

it("compares the final value after an ordinary assignment interrupts appends", () => {
	const tracker = track({ text: "a" });
	const change = tracker.beginChange();
	appendText(change.state, "text", "b");
	change.state.text = "c";
	appendText(change.state, "text", "d");
	const prepared = change.prepare();
	expect(prepared.ops).toEqual([["s", ["text"], "cd"]]);
	tracker.adopt(prepared);
	expect(tracker.value).toEqual({ text: "cd" });
});

it("rejects plain values and settled drafts", () => {
	expect(() => appendText({ text: "a" }, "text", "b")).toThrow("appendText() needs a draft");
	const tracker = track({ text: "a" });
	const change = tracker.beginChange();
	const draft = change.state;
	appendText(draft, "text", "b");
	tracker.adopt(change.prepare());
	expect(tracker.value).toEqual({ text: "ab" });
	expect(() => appendText(draft, "text", "c")).toThrow("settled overlay");
});
