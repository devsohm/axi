import { expect, test } from "vitest";
import { fuzzyFilter, fuzzyMatch } from "../src/fuzzy.ts";

test("model search ranks a later complete name above scattered letters", () => {
	const names = ["ezzlzzm", "vendor vendor/elm"];
	expect(fuzzyFilter(names, "elm", (name) => name)).toEqual(["vendor vendor/elm", "ezzlzzm"]);
	expect(fuzzyMatch("elm", "ezzlzzm elm")).toEqual({ matches: true, score: -22.299999999999997 });
});

test("a later word boundary can beat the first complete occurrence", () => {
	expect(fuzzyMatch("elm", "xelm/elm")).toEqual({ matches: true, score: -23.2 });
	expect(fuzzyMatch("ELM", "elm")).toEqual({ matches: true, score: -139.7 });
	expect(fuzzyMatch("elm", "empty")).toEqual({ matches: false, score: 0 });
});
