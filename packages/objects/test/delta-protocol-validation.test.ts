import { expect, test } from "vitest";
import {
	applyImmutable,
	assertValidOp,
	assertValidWireOp,
	decoder,
	diffRevisions,
	encoder,
	isBase,
	isReplace,
	PathError,
	UnsafePathError,
	type Op,
} from "../src/delta/index.ts";

test.each(
	[
		null,
		12,
		{},
		[],
		["r"],
		["r", 1, 2],
		["s", ["x"]],
		["s", {}, 1],
		["s", [], 1],
		["d", ["x"], 0],
		["d", 0],
		["d", []],
		["a", ["x"], 0],
		["a", ["x"]],
		["t", ["x"], -1],
		["t", ["x"], 1.5],
		["t", ["x"], Infinity],
		["t", ["x"]],
		["p", [], 0, 0],
		["p", [], -1, 0, []],
		["p", [], 0, 0.5, []],
		["p", [], 0, 0, {}],
		["m", [], [], "extra"],
		["m", [], null],
		["m", [], [0, 0]],
		["m", [], [2]],
		["m", [], [-1]],
		["unknown", ["x"]],
	].map((value) => ({ value })),
)("invalid expanded operation $value is rejected before application", ({ value }) => {
	expect(() => assertValidOp(value)).toThrow(TypeError);
});

test.each(
	[
		null,
		12,
		{},
		[],
		["r"],
		["r", null, 0],
		["s"],
		["s", {}, 1],
		["s", -1, 1],
		["d", ["x"], "extra"],
		["d", null],
		["a"],
		["a", 12],
		["a", ["x"], false],
		["a", ["x"], "a", "extra"],
		["t", -1],
		["t", 1.5],
		["t", ["x"], -1],
		["t", ["x"], 1, "extra"],
		["p"],
		["p", -1, 0, []],
		["p", 0, -1, []],
		["p", 0, 0, {}],
		["p", [], 0, 0, [], "extra"],
		["m"],
		["m", [0, 0]],
		["m", [], [1]],
		["m", [], [], "extra"],
		["#", 1],
		["#", -1, []],
		["#", 1, {}],
		["unknown"],
	].map((value) => ({ value })),
)("invalid wire operation $value is rejected without changing decoder state", ({ value }) => {
	expect(() => assertValidWireOp(value)).toThrow(TypeError);
	const read = decoder();
	expect(() => read.decode([value])).toThrow(TypeError);
	expect(read.decode([["r", { retained: true }]])).toEqual([["r", { retained: true }]]);
});

test.each(["__proto__", "constructor", "prototype"])("wire paths reject reserved segment %s", (segment) => {
	const read = decoder();
	expect(() => read.decode([["s", [segment, "polluted"], true]])).toThrow(UnsafePathError);
	expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
});

test("an empty leaf path passes wire framing but cannot resolve a leaf operation", () => {
	const wire = ["s", [], 1];
	expect(() => assertValidWireOp(wire)).not.toThrow();
	expect(() => decoder().decode([wire])).toThrow(PathError);
});

test("wire path dictionaries persist across batches but replacements reset their identities", () => {
	const write = encoder(),
		read = decoder();
	const initial = { text: "", other: 0 };
	const first: Op[] = [
		["s", ["text"], "a"],
		["s", ["other"], 1],
		["a", ["text"], "b"],
	];
	const next: Op[] = [
		["a", ["text"], "c"],
		["t", ["text"], 1],
	];
	expect(applyImmutable(initial, read.decode(write.encode(first)))).toEqual({ text: "ab", other: 1 });
	expect(applyImmutable({ text: "ab", other: 1 }, read.decode(write.encode(next)))).toEqual({ text: "bc", other: 1 });
	const replacement: Op[] = [["r", { text: "reset", other: 0 }]];
	expect(isBase(replacement)).toBe(true);
	expect(isBase(first)).toBe(false);
	expect(isBase([])).toBe(false);
	expect(isReplace(replacement[0])).toBe(true);
	expect(isReplace(first[0])).toBe(false);
	expect(read.decode(write.encode(replacement))).toEqual(replacement);
	expect(() => read.decode([["a", 0, "stale"]])).toThrow(PathError);
	expect(initial).toEqual({ text: "", other: 0 });
});

test("dense duplicates and large object replacements remain replayable without mutating the previous revision", () => {
	const before = { rows: Array.from({ length: 1000 }, (_, i) => i % 2) };
	const after = { rows: Array.from({ length: 1000 }, (_, i) => (i + 1) % 2) };
	expect(applyImmutable(before, diffRevisions(before, after))).toEqual(after);
	expect(before.rows[0]).toBe(0);
	const previous = Object.fromEntries(Array.from({ length: 4500 }, (_, i) => [`key-${i}`, i]));
	const next = Object.fromEntries(
		Array.from({ length: 4500 }, (_, i) => [`key-${i}`, i % 3 === 0 ? null : i % 3 === 1]),
	);
	expect(applyImmutable(previous, diffRevisions(previous, next))).toEqual(next);
	expect(previous["key-0"]).toBe(0);
	expect(previous["key-4499"]).toBe(4499);
});
