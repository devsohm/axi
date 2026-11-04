import { expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import { FollowSource, type FollowObserver } from "../src/host/follow.ts";
import { Batch, Derive, Source } from "../src/state/internal.ts";

function runtime(batch: Batch) {
	let observer: FollowObserver<unknown> | undefined,
		detached = 0;
	const ends: unknown[] = [];
	const source = new FollowSource(
		async (value) => {
			observer = value;
			return {
				value: { n: 0 },
				detach() {
					detached++;
				},
			};
		},
		{
			label: "runtime",
			context,
			ended(end) {
				ends.push(end);
			},
		},
		batch,
	);
	return {
		source,
		ends,
		detached: () => detached,
		set(n: number, retired = false) {
			observer!.advance(
				{ kind: "value", value: { n }, ops: [["s", ["n"], n]], retired },
				context,
			);
		},
		end() {
			observer!.end({ kind: "ended" });
		},
	};
}
const number = (value: unknown): number => {
	if (
		value &&
		typeof value === "object" &&
		"n" in value &&
		typeof value.n === "number"
	)
		return value.n;
	throw new Error("Invalid runtime value");
};
it("publishes two followed values as one derived update inside and outside a batch", async () => {
	const batch = new Batch(() => {}, undefined),
		left = runtime(batch),
		right = runtime(batch);
	await left.source.attach(context);
	await right.source.attach(context);
	let computations = 0;
	const sum = new Derive(
		[left.source, right.source],
		([a, b]) => {
			computations++;
			return number(a) + number(b);
		},
		batch,
	);
	sum.attach(
		(source) => {
			if (source instanceof Source) return source;
			throw new Error("Missing source");
		},
		() => {},
	);
	const watch = await sum.watch(context),
		values: unknown[] = [];
	watch.start(async (call) => {
		if (call.kind === "value") values.push(call.value);
	});
	batch.commit(() => {
		left.set(1);
		right.set(2);
	}, context);
	await new Promise((resolve) => setImmediate(resolve));
	left.set(3);
	right.set(4);
	await new Promise((resolve) => setImmediate(resolve));
	expect(values).toEqual([3, 7]);
	expect(computations).toBe(3);
	left.source.detach();
	right.source.detach();
	await watch.stop();
});
it("delivers a queued retirement before ending, retains its last value, and detaches once", async () => {
	const value = runtime(new Batch(() => {}, undefined));
	await value.source.attach(context);
	const watch = await value.source.watch(context),
		seen: unknown[] = [];
	watch.start(async (call) => {
		if (call.kind === "value") seen.push([call.value, call.retired]);
	});
	value.set(5, true);
	value.end();
	expect(await watch.closed).toEqual({ kind: "ended" });
	expect(seen).toEqual([[{ n: 5 }, true]]);
	const late = await value.source.watch(context);
	expect(late.value).toEqual({ n: 5 });
	expect(await late.closed).toEqual({ kind: "ended" });
	value.source.detach();
	value.source.detach();
	expect(value.detached()).toBe(1);
});
it("disposes an attachment that completes after the source was detached", async () => {
	const release = Promise.withResolvers<void>();
	let detach = 0;
	const source = new FollowSource(
		async () => {
			await release.promise;
			return {
				value: { n: 1 },
				detach() {
					detach++;
				},
			};
		},
		{ label: "late", context, ended() {} },
		new Batch(() => {}, undefined),
	);
	const attaching = source.attach(context);
	source.detach();
	release.resolve();
	await attaching;
	expect(detach).toBe(1);
	expect(() => source.value).toThrow("read before it attached");
});
