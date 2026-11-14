import { expect, test } from "vitest";
import { compareIds } from "../src/order.ts";

test.each([
	["a", "b", -1],
	["b", "a", 1],
	["same", "same", 0],
	["10", "2", -1],
	["Z", "a", -1],
	["z", "ä", -1],
	["", "a", -1],
] as const)("orders opaque identity %j against %j", (left, right, expected) => {
	expect(compareIds(left, right)).toBe(expected);
	expect(compareIds(right, left)).toBe(expected === 0 ? 0 : -expected);
});
