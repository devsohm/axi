import { expect, test } from "vitest";
import { appendText, applyImmutable, diffRevisions, track } from "../src/delta/index.ts";

test("array range mutators agree with native arrays for empty, negative, fractional and unbounded ranges", () => {
	const ranges = [undefined, -Infinity, -20, -2.5, -0, 0, NaN, 2.5, 20, Infinity];
	for (const size of [0, 1, 8, 63])
		for (const start of ranges)
			for (const end of ranges) {
				for (const method of ["fill", "copyWithin", "splice"] as const) {
					const initial = { values: Array.from({ length: size }, (_, index) => index % 7) };
					const expected = structuredClone(initial),
						tracker = track(initial),
						change = tracker.beginChange();
					const args =
						method === "fill" ? [9, start, end] : method === "copyWithin" ? [start, end, 6] : [start, end, 99, 100];
					const returned = Reflect.apply(change.state.values[method], change.state.values, args);
					const native = Reflect.apply(expected.values[method], expected.values, args);
					expect(returned, `${method}(${String(start)}, ${String(end)}) at ${size}`).toEqual(native);
					const ready = change.prepare();
					expect(ready.value).toEqual(expected);
					expect(applyImmutable(initial, ready.ops)).toEqual(expected);
					tracker.adopt(ready);
					expect(initial.values).toHaveLength(size);
				}
			}
});

test("array proxy reflection preserves data properties while refusing holes, symbols and prototype edits", () => {
	const tracker = track({ values: [1, 2, 3], count: 0 });
	const change = tracker.beginChange(),
		draft = change.state;
	try {
		expect(Object.keys(draft.values)).toEqual(["0", "1", "2"]);
		expect(Object.getOwnPropertyDescriptor(draft.values, "length")).toMatchObject({ value: 3, enumerable: false });
		expect(Object.getOwnPropertyDescriptor(draft.values, "99")).toBeUndefined();
		expect(Object.getOwnPropertyDescriptor(draft.values, "not-index")).toBeUndefined();
		expect(Object.getPrototypeOf(draft.values)).toBe(Array.prototype);
		expect(Object.isExtensible(draft.values)).toBe(true);
		for (const key of ["-1", "01", "1.0", "4294967295", "large-index-5", Symbol("private")])
			expect(() => Reflect.set(draft.values, key, 7)).toThrow(TypeError);
		for (const length of [-1, 1.5, NaN, Infinity, 4_294_967_296])
			expect(() => Reflect.set(draft.values, "length", length)).toThrow(RangeError);
		expect(() => Reflect.set(draft.values, 4, 7)).toThrow(TypeError);
		expect(() => Reflect.deleteProperty(draft.values, 0)).toThrow(TypeError);
		expect(() => Reflect.deleteProperty(draft, Symbol("private"))).toThrow(TypeError);
		expect(() => Object.defineProperty(draft, "hidden", { value: 1 })).toThrow(TypeError);
		expect(() => Object.setPrototypeOf(draft, null)).toThrow(TypeError);
		expect(() => Object.preventExtensions(draft)).toThrow(TypeError);
		expect(Reflect.has(draft.values, "0")).toBe(true);
		expect(Reflect.has(draft.values, "9")).toBe(false);
		expect(Reflect.has(draft.values, "map")).toBe(true);
		expect(Reflect.has(draft.values, Symbol.iterator)).toBe(true);
		draft.values.push(4);
		const ready = change.prepare();
		expect(ready.value).toEqual({ values: [1, 2, 3, 4], count: 0 });
		expect(() => {
			draft.count = 2;
		}).toThrow(TypeError);
		tracker.adopt(ready);
	} finally {
		change.abort();
	}
});

test("delete and reinsert keep native key order without allowing reserved names to change prototypes", () => {
	const initial: Record<string, number> = { first: 1, second: 2, third: 3 };
	Object.defineProperty(initial, "__proto__", { value: 4, writable: true, enumerable: true, configurable: true });
	const expected = Object.fromEntries([
		["second", 2],
		["first", 7],
		["__proto__", 9],
		["new", 11],
	]);
	const tracker = track(initial),
		change = tracker.beginChange();
	for (const name of ["first", "third", "__proto__"]) Reflect.deleteProperty(change.state, name);
	Reflect.set(change.state, "first", 7);
	Reflect.set(change.state, "__proto__", 9);
	Reflect.set(change.state, "new", 11);
	const ready = change.prepare();
	expect(ready.value).toEqual(expected);
	expect(Object.keys(ready.value)).toEqual(Object.keys(expected));
	const replayed = applyImmutable(initial, ready.ops);
	expect(replayed).toEqual(expected);
	expect(Object.getPrototypeOf(replayed)).toBe(Object.prototype);
	expect(Object.hasOwn(replayed, "__proto__")).toBe(true);
	tracker.adopt(ready);
	expect(initial.first).toBe(1);
});

test("incremental string append composes with explicit replacement and moved nested values", () => {
	const initial = { log: "initial", rows: [{ text: "one" }, { text: "two" }], stable: { ready: true } };
	const tracker = track(initial),
		change = tracker.beginChange(),
		moved = change.state.rows[0]!;
	appendText(change.state, "log", "");
	appendText(change.state, "log", "-a");
	appendText(change.state, "log", "-b");
	change.state.log = "rewritten";
	appendText(change.state, "log", "-c");
	change.state.rows.reverse();
	appendText(moved, "text", "!");
	const ready = change.prepare();
	expect(ready.value).toEqual({
		log: "rewritten-c",
		rows: [{ text: "two" }, { text: "one!" }],
		stable: { ready: true },
	});
	expect(ready.value.stable).toBe(initial.stable);
	expect(applyImmutable(initial, ready.ops)).toEqual(ready.value);
	tracker.adopt(ready);
	expect(initial.log).toBe("initial");
	expect(initial.rows[0]?.text).toBe("one");
});

test("large duplicate sequences and shared-object reorders produce a replayable diff", () => {
	const shared = Array.from({ length: 1200 }, (_, id) => ({ id, label: `item-${id}` }));
	for (const [before, after] of [
		[Array(700).fill(1), [2, ...Array(698).fill(1), 3]],
		[Array.from({ length: 600 }, (_, i) => i % 3), Array.from({ length: 600 }, (_, i) => (i + 1) % 3)],
		[shared, [...shared.slice(300, 900).reverse(), ...shared.slice(0, 300), ...shared.slice(900)]],
	]) {
		const previous = { rows: before },
			next = { rows: after };
		const unchanged = JSON.stringify(previous);
		expect(applyImmutable(previous, diffRevisions(previous, next))).toEqual(next);
		expect(JSON.stringify(previous)).toBe(unchanged);
	}
});
