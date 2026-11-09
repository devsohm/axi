import { expect, test } from "vitest";
import { applyImmutable, diffRevisions, track } from "../src/delta/index.ts";

type State = {
	rows: { id: number; count: number; detail: { label: string } }[];
	values: Record<string, number>;
	text: string;
};

function edit(state: State, operation: number, value: number): void {
	const row = () => ({ id: value, count: value % 13, detail: { label: `row-${value}` } });
	switch (operation) {
		case 0:
			state.rows.push(row());
			break;
		case 1:
			state.rows.pop();
			break;
		case 2:
			state.rows.unshift(row());
			break;
		case 3:
			state.rows.shift();
			break;
		case 4:
			state.rows.splice(value % (state.rows.length + 1), value % 4, row());
			break;
		case 5:
			state.rows.reverse();
			break;
		case 6:
			state.rows.sort((a, b) => a.count - b.count || a.id - b.id);
			break;
		case 7: {
			const item = state.rows[value % Math.max(1, state.rows.length)];
			if (item) {
				item.count += 2;
				item.detail.label += "!";
			}
			break;
		}
		case 8:
			state.values[`key-${value % 7}`] = value;
			break;
		case 9:
			delete state.values[`key-${value % 7}`];
			break;
		case 10:
			state.text += `/${value}`;
			break;
		case 11:
			state.text = state.text.slice(Math.min(state.text.length, value % 10));
			break;
		case 12:
			state.rows.length = Math.min(state.rows.length, value % 9);
			break;
		case 13: {
			const item = state.rows.shift();
			if (item) state.rows.push(item);
			break;
		}
		case 14:
			state.values = { [`fresh-${value % 3}`]: value };
			break;
		case 15:
			break;
		default:
			throw new Error("Unknown model operation");
	}
}

test.each([1, 17, 99, 1024, 65535])(
	"tracked revisions and replay agree with native JavaScript across edit sequences, seed %i",
	(seed) => {
		let random = seed;
		const next = () => (random = (Math.imul(random, 1664525) + 1013904223) >>> 0);
		let expected: State = {
			rows: Array.from({ length: 24 }, (_, id) => ({ id, count: id % 13, detail: { label: `initial-${id}` } })),
			values: {},
			text: "start",
		};
		const tracker = track(structuredClone(expected));
		const snapshots: { value: State; expected: State }[] = [];
		for (let step = 0; step < 200; step++) {
			const operation = (next() >>> 16) % 16,
				value = next();
			const previous = tracker.value,
				before = structuredClone(expected);
			if (step % 25 === 0) snapshots.push({ value: previous, expected: before });
			const change = tracker.beginChange();
			edit(change.state, operation, value);
			if (step % 19 === 0) {
				change.abort();
				expect(tracker.value).toBe(previous);
				expect(tracker.value).toEqual(before);
				continue;
			}
			const after = structuredClone(before);
			edit(after, operation, value);
			const ready = change.prepare();
			expect(previous).toEqual(before);
			expect(ready.value).toEqual(after);
			expect(applyImmutable(previous, ready.ops)).toEqual(after);
			expect(applyImmutable(previous, diffRevisions(previous, after))).toEqual(after);
			tracker.adopt(ready);
			expected = after;
			expect(tracker.value).toEqual(expected);
		}
		for (const saved of snapshots) expect(saved.value).toEqual(saved.expected);
	},
);

test("bulk array edits and later replacements keep previous snapshots detached", () => {
	const initial = { rows: Array.from({ length: 700 }, (_, id) => ({ id, score: 0 })), total: 0 };
	const tracker = track(initial);
	const change = tracker.beginChange();
	for (let id = 0; id < 600; id++) change.state.rows[id].score = id + 1;
	change.state.rows.splice(250, 100, { id: 900, score: 7 });
	change.state.rows.reverse();
	change.state.total = 600;
	const expected = structuredClone(initial);
	for (let id = 0; id < 600; id++) expected.rows[id].score = id + 1;
	expected.rows.splice(250, 100, { id: 900, score: 7 });
	expected.rows.reverse();
	expected.total = 600;
	const prepared = change.prepare();
	expect(prepared.value).toEqual(expected);
	expect(applyImmutable(initial, prepared.ops)).toEqual(expected);
	tracker.adopt(prepared);
	const previous = tracker.value;
	tracker.adopt(tracker.prepareReplace({ rows: [], total: 0 }));
	expect(previous).toEqual(expected);
	expect(initial.rows[500]).toEqual({ id: 500, score: 0 });
	expect(tracker.value).toEqual({ rows: [], total: 0 });
});
