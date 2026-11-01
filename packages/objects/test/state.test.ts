import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../src/context/index.ts";
import { replicatedState, type ReplicatedStateSourceFrame } from "../src/index.ts";

describe("published state", () => {
	it("does not report another source failure after disposal during frame validation", () => {
		let receive: (frame: ReplicatedStateSourceFrame<{ count: number }>) => void = () => {};
		const errors: Error[] = [];
		let closes = 0;
		const state = replicatedState(
			{
				attach: () => ({
					snapshot: { value: { count: 0 }, cursor: 0 },
					activate(listener) {
						receive = listener;
					},
					dispose() {
						closes++;
					},
				}),
			},
			{ onError: (error) => errors.push(error) },
		);
		receive({
			get cursor(): number {
				state.dispose();
				throw new Error("disposed during frame");
			},
			value: { count: 1 },
			context: BACKGROUND_CONTEXT,
			ops: [],
		});
		expect(closes).toBe(1);
		expect(errors).toEqual([]);
		expect(state.value).toEqual({ count: 0 });
	});
	it("rolls back a failed transaction and preserves ordered reentrant publications", () => {
		const state = replicatedState({ count: 0 });
		const received: string[] = [];
		state.subscribe((value) => {
			received.push(`first:${value.count}`);
			if (value.count === 1) state.replace(BACKGROUND_CONTEXT, { count: 2 });
		});
		state.subscribe((value) => received.push(`second:${value.count}`));
		expect(() =>
			state.change(BACKGROUND_CONTEXT, (draft) => {
				draft.count = 99;
				throw new Error("cancel change");
			}),
		).toThrow("cancel change");
		expect(state.value).toEqual({ count: 0 });
		state.change(BACKGROUND_CONTEXT, (draft) => {
			draft.count = 1;
		});
		expect(received).toEqual(["first:0", "second:0", "first:1", "second:1", "first:2", "second:2"]);
		expect(state.value).toEqual({ count: 2 });
	});

	it("keeps a rejected asynchronous change from publishing", async () => {
		const state = replicatedState({ count: 0 });
		const values: number[] = [];
		state.subscribe((value) => values.push(value.count));
		expect(() =>
			state.change(BACKGROUND_CONTEXT, async (draft) => {
				draft.count = 1;
				throw new Error("late failure");
			}),
		).toThrow(/synchronous/);
		await Promise.resolve();
		expect(state.value).toEqual({ count: 0 });
		expect(values).toEqual([0]);
	});

	it("detaches a broken source and reports cleanup failure with the original error", () => {
		let receive: (frame: ReplicatedStateSourceFrame<{ count: number }>) => void = () => {
			throw new Error("not attached");
		};
		let closes = 0;
		const cleanup = new Error("cleanup failed"),
			errors: Error[] = [];
		const initial = { count: 3 };
		const state = replicatedState(
			{
				attach: () => ({
					snapshot: { value: initial, cursor: 8 },
					activate(listener) {
						receive = listener;
					},
					dispose() {
						closes++;
						throw cleanup;
					},
				}),
			},
			{ onError: (error) => errors.push(error) },
		);
		receive({ cursor: 10, value: { count: 4 }, context: BACKGROUND_CONTEXT, ops: [] });
		expect(state.value).toBe(initial);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toBeInstanceOf(AggregateError);
		const aggregate = errors[0] as AggregateError;
		expect(aggregate.errors[0].message).toBe("Replicated state source cursor has a gap: expected 9, received 10");
		expect(aggregate.errors[1]).toBe(cleanup);
		receive({ cursor: 9, value: { count: 5 }, context: BACKGROUND_CONTEXT, ops: [] });
		state.dispose();
		expect(closes).toBe(1);
		expect(state.value).toBe(initial);
	});
});
