import { expect, it } from "vitest";
import { generateDiffString } from "../src/tools/edit-diff.ts";

const original = "a\nb\nc\nd\ne\nf\ng\nh\ni\n";
const updated = original.replace("e\n", "E\n");

it("renders integral context around a replacement", () => {
	expect(generateDiffString(original, updated, 1)).toEqual({
		diff: "    ...\n  4 d\n- 5 e\n+ 5 E\n  6 f\n    ...",
		firstChangedLine: 5,
	});
});

it("keeps fractional context slice and line-counter behavior", () => {
	expect(generateDiffString(original, updated, 1.5)).toEqual({
		diff: "    ...\n 3.5 c\n 4.5 d\n-5.5 e\n+5.5 E\n 6.5 f\n    ...",
		firstChangedLine: 5.5,
	});
});

it("keeps negative context slice and line-counter behavior", () => {
	expect(generateDiffString(original, updated, -1)).toEqual({
		diff: "    ...\n- 6 e\n+ 6 E\n  7 f\n  8 g\n  9 h\n    ...",
		firstChangedLine: 6,
	});
});
