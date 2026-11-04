import { expect, test } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import { replicatedState } from "../src/index.ts";

test("a slow state subscriber receives hydration first and converges after its delivery queue overflows", async () => {
	const state = replicatedState({ count: 0 });
	const blocked = Promise.withResolvers<void>();
	const settled = Promise.withResolvers<void>();
	const seen: { count: number; kind: string; sequence: number }[] = [];
	const stop = state.subscribe(async (value, _context, delivery) => {
		seen.push({ count: value.count, ...delivery });
		if (value.count === 0) await blocked.promise;
		if (value.count === 105) settled.resolve();
	});
	for (let count = 1; count <= 105; count++) state.replace(context, { count });
	expect(seen).toEqual([{ count: 0, kind: "hydrate", sequence: 0 }]);
	blocked.resolve();
	await settled.promise;
	expect(seen).toEqual([
		{ count: 0, kind: "hydrate", sequence: 0 },
		...[101, 102, 103, 104, 105].map((count) => ({ count, kind: "update", sequence: count })),
	]);
	stop();
	state.replace(context, { count: 106 });
	expect(state.value).toEqual({ count: 106 });
	expect(seen.at(-1)?.count).toBe(105);
});

test("disposing a blocked subscriber drops queued deliveries while other subscribers continue", async () => {
	const state = replicatedState({ count: 0 });
	const release = Promise.withResolvers<void>();
	const slow: number[] = [],
		fast: number[] = [];
	const stop = state.subscribe(async (value) => {
		slow.push(value.count);
		await release.promise;
	});
	const stopFast = state.subscribe((value) => {
		fast.push(value.count);
	});
	state.change(context, (value) => {
		value.count = 1;
	});
	stop();
	stop();
	release.resolve();
	await Promise.resolve();
	state.change(context, (value) => {
		value.count = 2;
	});
	expect(slow).toEqual([0]);
	expect(fast).toEqual([0, 1, 2]);
	stopFast();
});

test("source attachment failures clean up once and retain both original and cleanup errors", () => {
	let disposed = 0;
	const setup = new Error("activation failed"),
		cleanup = new Error("cleanup failed");
	try {
		replicatedState({
			attach: () => ({
				snapshot: { cursor: 0, value: { n: 3 } },
				activate() {
					throw setup;
				},
				dispose() {
					disposed++;
					throw cleanup;
				},
			}),
		});
		throw new Error("attachment unexpectedly succeeded");
	} catch (error) {
		expect(error).toBeInstanceOf(AggregateError);
		if (!(error instanceof AggregateError)) throw error;
		expect(error.errors).toEqual([setup, cleanup]);
	}
	expect(disposed).toBe(1);
	let invalidDisposed = 0;
	expect(() =>
		replicatedState({
			attach: () => ({
				snapshot: { cursor: 0.5, value: { n: 4 } },
				activate() {},
				dispose() {
					invalidDisposed++;
				},
			}),
		}),
	).toThrow("snapshot cursor must be a safe integer");
	expect(invalidDisposed).toBe(1);
});
