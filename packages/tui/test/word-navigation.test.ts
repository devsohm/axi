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
