import { expect, test } from "vitest";
import { applyImmutable, decoder, encoder, track } from "../src/delta/index.ts";

type State = { rows: number[]; text: string; enabled: boolean; fields: Record<string, number> };
test("revision replay matches an independent mutable model across mixed committed and aborted edits", () => {
	let model: State = {
		rows: Array.from({ length: 64 }, (_, i) => i),
		text: "start",
		enabled: false,
		fields: { initial: 1 },
	};
	const tracker = track(structuredClone(model)),
		wire = encoder(),
		reader = decoder();
	let seed = 17;
	const edits: ((state: State, value: number) => void)[] = [
		(state, value) => {
			state.rows.push(value);
		},
		(state) => {
			state.rows.pop();
		},
		(state) => {
			state.rows.shift();
		},
		(state, value) => {
			state.rows.unshift(value);
		},
		(state, value) => {
			state.rows.splice(2, 3, value, -value);
		},
		(state) => {
			state.rows.reverse();
		},
		(state) => {
			state.rows.sort((a, b) => a - b);
		},
		(state) => {
			state.rows.copyWithin(1, 3, 6);
		},
		(state, value) => {
			state.rows.fill(value, 2, 5);
		},
		(state, value) => {
			state.fields[`key${value % 5}`] = value;
			delete state.fields.initial;
		},
		(state) => {
			state.text += "界";
		},
		(state) => {
			state.text = state.text.slice(1);
		},
		(state) => {
			state.enabled = !state.enabled;
		},
	];
	for (let i = 0; i < 420; i++) {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
		const previous = structuredClone(model),
			snapshot = tracker.value,
			next = structuredClone(model),
			change = tracker.beginChange();
		const edit = edits[seed % edits.length]!;
		edit(next, seed % 100);
		edit(change.state, seed % 100);
		if (i % 17 === 0) {
			change.abort();
			expect(tracker.value).toEqual(previous);
			continue;
		}
		const prepared = change.prepare();
		expect(prepared.value).toEqual(next);
		expect(applyImmutable(snapshot, reader.decode(wire.encode(prepared.ops)))).toEqual(next);
		tracker.adopt(prepared);
		model = next;
		expect(tracker.value).toEqual(next);
		expect(snapshot).toEqual(previous);
	}
});
