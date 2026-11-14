import { expect, it } from "vitest";
import { findWordBackward, findWordForward, type WordNavigationOptions } from "../src/word-navigation.ts";

it.each([
	["forward", findWordForward],
	["backward", findWordBackward],
] as const)("captures %s word-navigation callbacks and calls them without a receiver", (_direction, navigate) => {
	const receivers: unknown[] = [];
	const visited: string[] = [];
	let segmentReads = 0;
	let atomicReads = 0;
	const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
	const options: WordNavigationOptions = {
		get segment() {
			segmentReads++;
			return function (this: unknown, text: string) {
				receivers.push(this);
				return segmenter.segment(text);
			};
		},
		get isAtomicSegment() {
			atomicReads++;
			return function (this: unknown, text: string) {
				receivers.push(this);
				visited.push(text);
				return false;
			};
		},
	};
	expect(navigate(" value ", navigate === findWordForward ? 0 : 7, options)).toBe(navigate === findWordForward ? 6 : 1);
	expect(segmentReads).toBe(1);
	expect(atomicReads).toBe(1);
	expect(receivers).toEqual([undefined, undefined, undefined, undefined]);
	expect(visited).toEqual([" ", "value", "value"]);
});

it("word navigation handles empty input, whitespace-only input and punctuation runs", () => {
	expect(findWordForward("", 0)).toBe(0);
	expect(findWordBackward("", 0)).toBe(0);
	expect(findWordForward("word", 4)).toBe(4);
	expect(findWordBackward("word", -1)).toBe(0);
	expect(findWordForward("   ", 0)).toBe(3);
	expect(findWordBackward("   ", 3)).toBe(0);
	expect(findWordForward("!?+ word", 0)).toBe(3);
	expect(findWordBackward("word !?+", 8)).toBe(5);
	expect(findWordForward("🙂👍 word", 0)).toBe(4);
	expect(findWordBackward("word 🙂👍", 9)).toBe(5);
});

it("custom word segments retain ASCII punctuation boundaries and permit atomic markers", () => {
	const segment: WordNavigationOptions["segment"] = (text) => [
		{ segment: text, input: text, index: 0, isWordLike: true },
	];
	expect(findWordForward("alpha.beta", 0, { segment })).toBe(5);
	expect(findWordBackward("alpha.beta", 10, { segment })).toBe(6);
	const atomic = { segment, isAtomicSegment: (part: string) => part === "[paste]" };
	expect(findWordForward("[paste]", 0, atomic)).toBe(7);
	expect(findWordBackward("[paste]", 7, atomic)).toBe(0);
});
