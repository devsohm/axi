import { expect, test } from "vitest";
import { applyImmutable, track } from "../src/delta/index.ts";

test.each(["contiguous", "alternating"] as const)(
	"dense %s edits replay correctly without changing previous revisions",
	(pattern) => {
		const initial = {
			rows: Array.from({ length: 1200 }, (_, id) => ({ id, nested: { count: 0, text: "before" } })),
			stable: { label: "unchanged" },
		};
		const expected = {
			rows: initial.rows.map((row, index) => ({
				id: index,
				nested: (pattern === "contiguous" ? index < 700 : index % 2 === 0)
					? { count: index + 1, text: "after" }
					: { ...row.nested },
			})),
			stable: { label: "unchanged" },
		};
		const original = JSON.stringify(initial),
			tracker = track(initial),
			change = tracker.beginChange();
		for (const [index, row] of change.state.rows.entries()) {
			if (!(pattern === "contiguous" ? index < 700 : index % 2 === 0)) continue;
			row.nested.count = index + 1;
			row.nested.text = "after";
		}
		const prepared = change.prepare();
		expect(prepared.baseRevision).toBe(0);
		expect(prepared.value).toEqual(expected);
		expect(applyImmutable(initial, prepared.ops)).toEqual(expected);
		expect(prepared.value.stable).toBe(initial.stable);
		tracker.adopt(prepared);
		expect(tracker.revision).toBe(1);
		expect(JSON.stringify(initial)).toBe(original);
	},
);

test("dense edits below a reserved property replay through safe ancestor replacements", () => {
	const initial = {
		constructor: { rows: Array.from({ length: 700 }, (_, id) => ({ id, count: 0 })) },
		untouched: [1, 2],
	};
	const tracker = track(initial),
		change = tracker.beginChange();
	for (const row of change.state.constructor.rows) row.count = row.id + 1;
	const prepared = change.prepare();
	const expected = {
		constructor: { rows: initial.constructor.rows.map((row) => ({ id: row.id, count: row.id + 1 })) },
		untouched: [1, 2],
	};
	expect(prepared.value).toEqual(expected);
	expect(applyImmutable(initial, prepared.ops)).toEqual(expected);
	expect(prepared.value.untouched).toBe(initial.untouched);
	tracker.adopt(prepared);
	expect(initial.constructor.rows.every((row) => row.count === 0)).toBe(true);
});

test.each(["set", "delete"] as const)(
	"thousands of object %s operations preserve the complete revision",
	(operation) => {
		const initial: Record<string, number> = Object.fromEntries(
			Array.from({ length: 4200 }, (_, index) => [`key${index}`, index]),
		);
		const tracker = track(initial),
			change = tracker.beginChange();
		for (let index = 0; index < 4200; index++) {
			if (operation === "delete") delete change.state[`key${index}`];
			else change.state[`key${index}`] = -index - 1;
		}
		change.state.added = 99;
		const expected =
			operation === "delete"
				? { added: 99 }
				: {
						...Object.fromEntries(Array.from({ length: 4200 }, (_, index) => [`key${index}`, -index - 1])),
						added: 99,
					};
		const prepared = change.prepare();
		expect(prepared.value).toEqual(expected);
		expect(applyImmutable(initial, prepared.ops)).toEqual(expected);
		tracker.adopt(prepared);
		expect(initial.key0).toBe(0);
		expect(Object.hasOwn(initial, "added")).toBe(false);
	},
);

test("adopting one of hundreds of competing drafts invalidates every earlier open or prepared change", () => {
	const tracker = track({ value: -1, rows: [] as number[] });
	const changes = Array.from({ length: 300 }, (_, value) => {
		const change = tracker.beginChange();
		change.state.value = value;
		change.state.rows.push(value);
		return { change, prepared: value % 2 === 0 ? change.prepare() : undefined };
	});
	const last = changes.at(-1);
	if (!last) throw new Error("Missing candidate");
	const selected = last.change.prepare();
	expect(selected.baseRevision).toBe(0);
	tracker.adopt(selected);
	expect(tracker.value).toEqual({ value: 299, rows: [299] });
	for (const previous of changes.slice(0, -1)) {
		const prepared = previous.prepared;
		if (prepared) expect(() => tracker.adopt(prepared)).toThrow(/stale/);
		else
			expect(() => {
				previous.change.state.value = 500;
			}).toThrow(TypeError);
		previous.change.abort();
	}
	expect(tracker.revision).toBe(1);
});

test("a dense array revision retains every nested edit beyond a single operation batch", () => {
	const initial = { rows: Array.from({ length: 4300 }, (_, id) => ({ id, value: 0, ready: false })) };
	const tracker = track(initial),
		change = tracker.beginChange();
	for (const row of change.state.rows) {
		row.value = row.id + 1;
		row.ready = true;
	}
	const prepared = change.prepare();
	const expected = { rows: initial.rows.map(({ id }) => ({ id, value: id + 1, ready: true })) };
	expect(prepared.value).toEqual(expected);
	expect(applyImmutable(initial, prepared.ops)).toEqual(expected);
	tracker.adopt(prepared);
	expect(initial.rows.every((row) => row.value === 0 && !row.ready)).toBe(true);
});
