import { expect, test } from "vitest";
import { NativeWatch, type NativeWatchable, Watch, type Watchable } from "../src/index.ts";
import { BACKGROUND_CONTEXT, withAbortSignal } from "../src/context/index.ts";

const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("JSON watches serialize frames, bound the pending queue and detach on cancellation", async () => {
	const signal = new AbortController();
	let detached = 0;
	const watch = new Watch(
		0,
		() => detached++,
		(error) => {
			throw error;
		},
	);
	const source: Watchable<number> = { value: 0, watch: async () => watch };
	const acquired = await source.watch(BACKGROUND_CONTEXT);
	watch.observeCancellation(signal.signal);
	const release = Promise.withResolvers<void>();
	const seen: number[] = [];
	acquired.start(async (value, _ops, context) => {
		seen.push(value);
		expect(context.abortSignal).toBeUndefined();
		if (value === 1) await release.promise;
	});
	watch.advance(1, [["r", 1]], withAbortSignal(signal.signal, BACKGROUND_CONTEXT));
	expect(seen).toEqual([]);
	await turn();
	for (let value = 2; value <= 102; value++) watch.advance(value, [["r", value]], BACKGROUND_CONTEXT);
	release.resolve();
	await turn();
	expect(seen).toEqual([1, 102]);
	signal.abort();
	expect(await acquired.closed).toEqual({ reason: "cancelled" });
	expect(detached).toBe(1);
	expect(await acquired.stop()).toEqual({ reason: "cancelled" });
	expect(acquired.value).toBe(102);
});

test("native watches preserve object identity and null JSON values do not retire their source", async () => {
	const first = { name: "first" },
		second = { name: "second" };
	const native = new NativeWatch(
		first,
		() => {},
		(error) => {
			throw error;
		},
	);
	let observed: object | undefined;
	const source: NativeWatchable<typeof first> = { value: first, watch: async () => native };
	const acquired = await source.watch(BACKGROUND_CONTEXT);
	acquired.start(async (value) => {
		observed = value;
	});
	native.advance(second, BACKGROUND_CONTEXT);
	await turn();
	expect(observed).toBe(second);
	expect(native.value).toBe(second);
	expect(await native.stop()).toEqual({ reason: "stopped" });
	const json = new Watch<number | null>(
		1,
		() => {},
		(error) => {
			throw error;
		},
	);
	const seen: (number | null)[] = [];
	json.start(async (value) => {
		seen.push(value);
	});
	json.advance(null, [["r", null]], BACKGROUND_CONTEXT);
	json.advance(2, [["r", 2]], BACKGROUND_CONTEXT);
	json.retire(BACKGROUND_CONTEXT);
	json.advance(3, [["r", 3]], BACKGROUND_CONTEXT);
	expect(await json.closed).toEqual({ reason: "retired" });
	expect(seen).toEqual([null, 2, null]);
});
