import { expect, test } from "vitest";
import { applyImmutable, track } from "../src/delta/index.ts";

test.each([
	["pop", []],
	["shift", []],
	["unshift", [8, 9]],
	["splice", [1, 1, 7]],
	["reverse", []],
	["sort", []],
	["fill", [5, 1, 3]],
	["copyWithin", [0, 1, 3]],
] as const)("a borrowed %s mutator preserves native behavior on ordinary arrays", (name, args) => {
	const tracker = track({ values: [3, 1, 2] }),
		change = tracker.beginChange();
	try {
		const actual = [3, 1, 2],
			expected = [...actual];
		expect(Reflect.apply(change.state.values[name], actual, args)).toEqual(
			Reflect.apply(expected[name], expected, args),
		);
		expect(actual).toEqual(expected);
		expect(change.prepare().ops).toEqual([]);
		expect(tracker.value).toEqual({ values: [3, 1, 2] });
	} finally {
		change.abort();
	}
});

test.each(["replace", "append", "truncate", "remove", "reverse"] as const)(
	"sort preserves native results when its comparator performs a %s edit",
	(operation) => {
		const initial = { values: [4, 1, 3, 2], stable: { label: "untouched" } },
			tracker = track(initial),
			change = tracker.beginChange();
		const expected = structuredClone(initial);
		const sort = (values: number[]) => {
			let changed = false;
			values.sort((left, right) => {
				if (!changed) {
					changed = true;
					switch (operation) {
						case "replace":
							values[0] = 9;
							break;
						case "append":
							values.push(8);
							break;
						case "truncate":
							values.length = 1;
							break;
						case "remove":
							values.splice(1, 1);
							break;
						case "reverse":
							values.reverse();
							break;
					}
				}
				return left - right;
			});
		};
		sort(expected.values);
		sort(change.state.values);
		const ready = change.prepare();
		expect(ready.value).toEqual(expected);
		expect(applyImmutable(initial, ready.ops)).toEqual(expected);
		expect(ready.value.stable).toBe(initial.stable);
		tracker.adopt(ready);
		expect(initial.values).toEqual([4, 1, 3, 2]);
	},
);

test("sorting mixes inserted and replaced values without retaining comparator writes", () => {
	const initial = { values: [4, 1, 3, 2] },
		tracker = track(initial),
		change = tracker.beginChange(),
		expected = structuredClone(initial);
	const edit = (values: number[]) => {
		values[0] = 7;
		values.splice(2, 0, 6, 5);
		values[2] = 8;
		let compared = false;
		values.sort((left, right) => {
			if (!compared) {
				compared = true;
				values[2] = 99;
				values[0] = 100;
			}
			return left - right;
		});
	};
	edit(expected.values);
	edit(change.state.values);
	const ready = change.prepare();
	expect(ready.value).toEqual(expected);
	expect(applyImmutable(initial, ready.ops)).toEqual(expected);
	tracker.adopt(ready);
	expect(tracker.value).toEqual(expected);
});

test("invalid comparator and non-array receiver errors do not poison the open change", () => {
	const tracker = track({ values: [3, 1, 2], object: { count: 0 } }),
		change = tracker.beginChange();
	expect(() => Reflect.apply(change.state.values.sort, change.state.values, [4])).toThrow(TypeError);
	expect(() => Reflect.apply(change.state.values.reverse, change.state.object, [])).toThrow(TypeError);
	change.state.values.sort();
	change.state.object.count++;
	const ready = change.prepare();
	tracker.adopt(ready);
	expect(tracker.value).toEqual({ values: [1, 2, 3], object: { count: 1 } });
});

test("sorting already ordered insertions keeps a replayable revision and old snapshots", () => {
	const initial = { values: [1, 4] },
		tracker = track(initial),
		change = tracker.beginChange();
	change.state.values.splice(1, 0, 2, 3);
	change.state.values.sort();
	const first = change.prepare();
	tracker.adopt(first);
	const saved = tracker.value,
		next = tracker.beginChange();
	next.state.values[1] = 20;
	next.state.values.splice(2, 0, 5);
	next.state.values.sort();
	const second = next.prepare();
	expect(second.value).toEqual({ values: [1, 20, 3, 4, 5] });
	expect(applyImmutable(saved, second.ops)).toEqual(second.value);
	tracker.adopt(second);
	expect(saved).toEqual({ values: [1, 2, 3, 4] });
	expect(initial).toEqual({ values: [1, 4] });
});

test("zero-argument and one-argument splice retain native removal semantics after insertion", () => {
	const initial = { values: [1, 2, 3] },
		tracker = track(initial),
		change = tracker.beginChange();
	change.state.values.unshift(0);
	expect(Reflect.apply(change.state.values.splice, change.state.values, [])).toEqual([]);
	expect(change.state.values.splice(2)).toEqual([2, 3]);
	const ready = change.prepare();
	expect(ready.value).toEqual({ values: [0, 1] });
	expect(applyImmutable(initial, ready.ops)).toEqual(ready.value);
	tracker.adopt(ready);
});
