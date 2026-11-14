import { expect, test } from "vitest";
import { applyImmutable, diffRevisions, track } from "../src/delta/index.ts";

type State = {
	values: number[];
	rows: { id: number; detail: { text: string; count: number } }[];
	fields: Record<string, number | { text: string }>;
};

function edit(state: State, op: number, value: number): void {
	const length = state.values.length;
	const index = value % (length + 1);
	const row = () => ({ id: value, detail: { text: `value ${value}`, count: 0 } });
	switch (op) {
		case 0:
			state.values.push(value, -value);
			break;
		case 1:
			state.values.unshift(value);
			break;
		case 2:
			state.values.splice(index, value % 4, value, 0);
			break;
		case 3:
			state.values.splice(-index, value % 3);
			break;
		case 4:
			state.values.reverse();
			break;
		case 5:
			state.values.sort((a, b) => a - b);
			break;
		case 6:
			state.values.fill(value, -index, length - (value % 4));
			break;
		case 7:
			state.values.copyWithin(index, -index, length - (value % 3));
			break;
		case 8:
			state.values.pop();
			break;
		case 9:
			state.values.shift();
			break;
		case 10:
			state.values.length = Math.min(length, value % 12);
			break;
		case 11:
			if (length) state.values[value % length] = value;
			break;
		case 12:
			state.rows.push(row());
			break;
		case 13:
			state.rows.unshift(row());
			break;
		case 14:
			state.rows.splice(value % (state.rows.length + 1), value % 3, row());
			break;
		case 15:
			state.rows.reverse();
			break;
		case 16:
			state.rows.sort((a, b) => a.id - b.id);
			break;
		case 17:
			state.rows.pop();
			break;
		case 18:
			state.rows.shift();
			break;
		case 19: {
			const item = state.rows[value % Math.max(1, state.rows.length)];
			if (item) {
				item.detail.count++;
				item.detail.text += ".";
			}
			break;
		}
		case 20: {
			const item = state.rows[value % Math.max(1, state.rows.length)];
			if (item) item.detail = { text: item.detail.text, count: item.detail.count };
			break;
		}
		case 21:
			state.fields[`field${value % 8}`] = value;
			break;
		case 22:
			state.fields[`field${value % 8}`] = { text: `text ${value}` };
			break;
		case 23:
			delete state.fields[`field${value % 8}`];
			break;
		case 24: {
			const key = `field${value % 8}`;
			delete state.fields[key];
			state.fields[key] = { text: "reinserted" };
			break;
		}
		case 25: {
			const key = `field${value % 8}`;
			state.fields[key] = { text: "temporary" };
			state.fields[key] = { text: "final" };
			break;
		}
		case 26:
			state.values = [...state.values];
			break;
		case 27:
			state.fields = { ...state.fields };
			break;
		default:
			throw new Error("Unknown edit");
	}
}

test.each([7, 31, 2053, 65537, 987654321])(
	"batched edits agree with native values, replay and revision isolation, seed %i",
	(seed) => {
		let random = seed;
		const next = () => (random = (Math.imul(random, 1664525) + 1013904223) >>> 0);
		let expected: State = { values: [4, 1, 8, 3, 5], rows: [], fields: {} };
		const tracker = track(structuredClone(expected));
		const retained: { value: State; expected: State }[] = [];
		for (let round = 0; round < 240; round++) {
			const base = tracker.value,
				before = structuredClone(expected),
				change = tracker.beginChange();
			if (round % 24 === 0) retained.push({ value: base, expected: before });
			expected = structuredClone(expected);
			const count = 2 + ((next() >>> 20) % 10);
			for (let step = 0; step < count; step++) {
				const op = (next() >>> 16) % 28,
					value = next() % 10000;
				edit(change.state, op, value);
				edit(expected, op, value);
			}
			if (round % 17 === 0) {
				change.abort();
				expected = before;
				expect(tracker.value).toBe(base);
			} else {
				const ready = change.prepare();
				expect(ready.value, `round ${round}`).toEqual(expected);
				expect(applyImmutable(base, ready.ops), `replay ${round}`).toEqual(expected);
				expect(applyImmutable(base, diffRevisions(base, ready.value))).toEqual(expected);
				tracker.adopt(ready);
			}
			expect(base).toEqual(before);
			expect(tracker.value).toEqual(expected);
		}
		for (const snapshot of retained) expect(snapshot.value).toEqual(snapshot.expected);
	},
);
