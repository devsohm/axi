import { expect, test } from "vitest";
import { NativeWatch, type NativeWatchable, Watch, type Watchable } from "../src/watch.ts";
import { BACKGROUND_CONTEXT, withAbortSignal } from "../src/context/index.ts";

const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("normal watch endings reuse their metadata across JSON and native handles", async () => {
	for (const kind of ["stopped", "aborted", "ended"] as const) {
		const watches = [Watch, Watch, NativeWatch].map(
			(Constructor) =>
				new Constructor(
					null,
					() => {},
					() => {},
				),
		);
		for (const watch of watches) {
			if (kind === "stopped") void watch.stop();
			else if (kind === "aborted") watch.abort();
			else watch.endAfterDelivery();
		}
		const ends = await Promise.all(watches.map((watch) => watch.closed));
		expect(ends[0]).toEqual({ kind });
		expect(ends[1]).toBe(ends[0]);
		expect(ends[2]).toBe(ends[0]);
	}
});

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
	watch.observeAbort(signal.signal);
	const release = Promise.withResolvers<void>();
	const seen: number[] = [];
	acquired.start(async (call, context) => {
		if (call.kind !== "value") throw call.error;
		const value = call.value;
		seen.push(value);
		expect(context.abortSignal).toBeUndefined();
		if (value === 1) await release.promise;
	});
	watch.advance(
		{ kind: "value", value: 1, ops: [["r", 1]], retired: false },
		withAbortSignal(signal.signal, BACKGROUND_CONTEXT),
	);
	expect(seen).toEqual([]);
	await turn();
	for (let value = 2; value <= 102; value++)
		watch.advance({ kind: "value", value, ops: [["r", value]], retired: false }, BACKGROUND_CONTEXT);
	release.resolve();
	await turn();
	expect(seen).toEqual([1, 102]);
	signal.abort();
	expect(await acquired.closed).toEqual({ kind: "aborted" });
	expect(detached).toBe(1);
	expect(await acquired.stop()).toEqual({ kind: "aborted" });
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
	acquired.start(async (call) => {
		if (call.kind === "value") observed = call.value;
	});
	native.advance(second, BACKGROUND_CONTEXT);
	await turn();
	expect(observed).toBe(second);
	expect(native.value).toBe(second);
	expect(await native.stop()).toEqual({ kind: "stopped" });
	const json = new Watch<number | null>(
		1,
		() => {},
		(error) => {
			throw error;
		},
	);
	const seen: (number | null)[] = [];
	json.start(async (call) => {
		if (call.kind === "value") seen.push(call.value);
	});
	json.advance({ kind: "value", value: null, ops: [["r", null]], retired: false }, BACKGROUND_CONTEXT);
	await turn();
	json.advance({ kind: "value", value: 2, ops: [["r", 2]], retired: false }, BACKGROUND_CONTEXT);
	await turn();
	json.advance({ kind: "value", value: 2, ops: [], retired: true }, BACKGROUND_CONTEXT);
	await turn();
	json.advance({ kind: "value", value: 3, ops: [["r", 3]], retired: false }, BACKGROUND_CONTEXT);
	await turn();
	expect(await json.stop()).toEqual({ kind: "stopped" });
	expect(seen).toEqual([null, 2, 2, 3]);
});
