import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context, withAbortSignal } from "../src/context/index.ts";
import type { JsonValue } from "../src/json.ts";
import { constant, mapShared } from "../src/index.ts";
import {
	Batch,
	type BatchError,
	Derive,
	FollowedSource,
	type NativeStart,
	Source,
	WritableSource,
} from "../src/state/internal.ts";
import type { NativeWatchCall, WatchCall, WatchEnd } from "../src/watch.ts";

async function delivered(): Promise<void> {
	for (let i = 0; i < 8; i++) await Promise.resolve();
}
function environment() {
	const errors: BatchError[] = [];
	const batch = new Batch((error) => errors.push(error), undefined);
	return { batch, errors, owner: { context, assertUsable() {} } };
}
class Recoverable extends FollowedSource<number> {
	#state: NativeStart<number> = { kind: "value", value: 1 };
	get value(): number {
		return this.#state.kind === "value" ? this.#state.value : this.#state.last!.value;
	}
	override start(): NativeStart<number> {
		return this.#state;
	}
	update(state: NativeStart<number>): void {
		this.#state = state;
		this.changed();
	}
	close(): void {
		this.end();
	}
}

describe("experimental state", () => {
	it("isolates synchronous native calls and shares terminal records with every follower", async () => {
		const { batch } = environment();
		class JsonSource extends Source {
			get value(): JsonValue {
				return 1;
			}
			deliver(): void {}
			close(): void {
				this.endWatches();
			}
		}
		const json = new JsonSource(batch);
		const jsonWatches = [await json.watch(context), await json.watch(context)];
		json.close();
		const jsonEnds = await Promise.all(jsonWatches.map((watch) => watch.closed));
		expect(jsonEnds[0]).toEqual({ kind: "ended" });
		expect(jsonEnds[1]).toBe(jsonEnds[0]);
		const source = new Recoverable(batch);
		const watches = [await source.watch(context), await source.watch(context)];
		const calls: NativeWatchCall<number>[][] = [[], []];
		const ends: WatchEnd[] = [],
			aborts: WatchEnd[] = [];
		for (let index = 0; index < 2; index++) {
			source.observe(
				{
					advance(call) {
						calls[index]!.push(call);
					},
					end(end) {
						ends.push(end);
					},
				},
				context,
			);
			const controller = new AbortController();
			source.observe(
				{
					advance() {},
					end(end) {
						aborts.push(end);
					},
				},
				withAbortSignal(controller.signal, context),
			);
			controller.abort();
		}
		batch.commit(() => source.update({ kind: "value", value: 2 }), context);
		const error = new Error("unavailable");
		batch.commit(() => source.update({ kind: "failed", error, last: { value: 2 } }), context);
		for (const frames of calls)
			expect(frames).toEqual([
				{ kind: "value", value: 2 },
				{ kind: "failed", error },
			]);
		expect(calls[0]![0]).not.toBe(calls[1]![0]);
		expect(calls[0]![1]).not.toBe(calls[1]![1]);
		source.close();
		const watchEnds = await Promise.all(watches.map((watch) => watch.closed));
		const late = await source.watch(context);
		for (const end of [...watchEnds, ...ends, await late.closed]) expect(end).toBe(watchEnds[0]);
		expect(watchEnds[0]).toEqual({ kind: "ended" });
		expect(aborts).toEqual([{ kind: "aborted" }, { kind: "aborted" }]);
		expect(aborts[1]).toBe(aborts[0]);
	});
	it("delivers before flushing, defers changes during a flush, and joins microtask changes", async () => {
		const { batch, errors } = environment();
		const seen: string[] = [];
		batch.commit(() => {
			batch.changed({
				deliver() {
					seen.push("delivery");
				},
			});
			batch.flushing(() => {
				seen.push("flush");
				batch.within(() => seen.push("next commit"), context);
			});
			batch.flushing(() => {
				throw new Error("failed flush");
			});
			batch.flushing(() => seen.push("last flush"));
		}, context);
		expect(seen).toEqual(["delivery", "flush", "last flush", "next commit"]);
		expect(errors).toMatchObject([{ kind: "delivery_failed", error: { message: "failed flush" } }]);
		batch.soon(() => seen.push("one"), context);
		batch.soon(() => seen.push("two"), context);
		expect(seen).toHaveLength(4);
		await delivered();
		expect(seen.slice(4)).toEqual(["one", "two"]);
	});
	it("publishes identity changes once per batch and refuses changes from pure computes", async () => {
		const { batch, owner } = environment();
		const source = new WritableSource(1, owner, batch);
		const seen: NativeWatchCall<number>[] = [];
		(await source.watch(context)).start(async (call) => {
			seen.push(call);
		});
		source.set(1);
		batch.commit(() => {
			source.set(2);
			source.set(3);
		}, context);
		source.set(4);
		await delivered();
		expect(seen).toEqual([
			{ kind: "value", value: 3 },
			{ kind: "value", value: 4 },
		]);
		expect(() => batch.compute(() => source.set(5))).toThrow(
			expect.objectContaining({ code: "invalid", reason: "reentrant" }),
		);
		expect(source.value).toBe(4);
	});
	it("takes a snapshot and observes synchronously, reporting one call per failure episode", () => {
		const { batch } = environment();
		const source = new Recoverable(batch);
		const seen: unknown[] = [];
		const controller = new AbortController();
		const observer = source.observe(
			{
				advance(call) {
					seen.push(call);
				},
				end(end) {
					seen.push(end);
				},
			},
			withAbortSignal(controller.signal, context),
		);
		expect(observer.value).toBe(1);
		const failure = new Error("compose failed");
		const failed: NativeStart<number> = { kind: "failed", error: failure, last: { value: 1 } };
		batch.commit(() => source.update(failed), context);
		batch.commit(() => source.update(failed), context);
		batch.commit(() => source.update({ kind: "value", value: 1 }), context);
		expect(seen).toEqual([
			{ kind: "failed", error: failure },
			{ kind: "value", value: 1 },
		]);
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
		controller.abort();
		expect(seen.at(-1)).toEqual({ kind: "aborted" });
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
		observer.detach();
	});
	it("opens failed native watches at the last good value and ends them when their source closes", async () => {
		const { batch } = environment();
		const source = new Recoverable(batch);
		const error = new Error("unavailable");
		batch.commit(() => source.update({ kind: "failed", error, last: { value: 1 } }), context);
		const watch = await source.watch(context);
		const calls: NativeWatchCall<number>[] = [];
		expect(watch.value).toBe(1);
		watch.start(async (call) => {
			calls.push(call);
		});
		await delivered();
		expect(calls).toEqual([{ kind: "failed", error }]);
		source.close();
		expect(await watch.closed).toEqual({ kind: "ended" });
	});
	it("pulls a diamond once, folds JSON frames, and lazily recomputes after all watches stop", async () => {
		const { batch, owner, errors } = environment();
		const source = new WritableSource(1, owner, batch);
		let computes = 0;
		const left = new Derive(
			[source],
			([value]) => {
				computes++;
				return Number(value) + 1;
			},
			batch,
		);
		const right = new Derive(
			[source],
			([value]) => {
				computes++;
				return Number(value) + 2;
			},
			batch,
		);
		const total = new Derive(
			[left, right],
			([a, b]) => {
				computes++;
				return Number(a) + Number(b);
			},
			batch,
		);
		left.attach(
			() => source,
			() => {},
		);
		right.attach(
			() => source,
			() => {},
		);
		total.attach(
			(_, index) => (index === 0 ? left : right),
			() => {},
		);
		expect(total.value).toBe(5);
		const watch = await total.watch(context);
		const calls: WatchCall<JsonValue>[] = [];
		watch.start(async (call) => {
			calls.push(call);
		});
		batch.commit(() => {
			source.set(2);
			source.set(3);
		}, context);
		expect(computes).toBe(6);
		await delivered();
		expect(calls).toEqual([{ kind: "value", value: 9, ops: [["r", 9]], retired: false }]);
		await watch.stop();
		source.set(4);
		expect(computes).toBe(6);
		expect(total.value).toBe(11);
		expect(computes).toBe(9);
		expect(errors).toEqual([]);
	});
	it("keeps failed derives watchable, reports each failure episode once and recovers with a replacement", async () => {
		const { batch, owner } = environment();
		const source = new WritableSource(0, owner, batch);
		const error = new Error("negative");
		const reported: unknown[] = [];
		const derive = new Derive(
			[source],
			([value]) => {
				if (Number(value) < 0) throw error;
				return Number(value);
			},
			batch,
		);
		derive.attach(
			() => source,
			(failure) => reported.push(failure),
		);
		const calls: WatchCall<JsonValue>[] = [];
		const watch = await derive.watch(context);
		watch.start(async (call) => {
			calls.push(call);
		});
		source.set(-1);
		await delivered();
		source.set(-2);
		await delivered();
		expect(reported).toEqual([error]);
		source.set(7);
		await delivered();
		expect(calls).toEqual([
			{ kind: "failed", error },
			{ kind: "value", value: 7, ops: [["r", 7]], retired: false },
		]);
		derive.detach(new Error("released"));
		expect(await watch.closed).toEqual({ kind: "ended" });
		expect(() => derive.value).toThrow("released");
	});
	it("seals writable ownership while retaining the final readable value", async () => {
		const { batch, owner } = environment();
		const source = new WritableSource({ n: 1 }, owner, batch);
		const watch = await source.watch(context);
		const error = new Error("ended");
		source.detach(error);
		expect(await watch.closed).toEqual({ kind: "ended" });
		expect(() => source.set(source.value)).toThrow(error);
		expect(source.value).toEqual({ n: 1 });
	});
	it("caches object mappings by identity and leaves constants unchanged until stopped or cancelled", async () => {
		let calls = 0;
		const map = mapShared((item: { n: number } | number) => {
			calls++;
			return { n: typeof item === "number" ? item : item.n };
		});
		const item = { n: 1 };
		const first = map([item, 2]);
		const second = map([item, 2]);
		expect(first[0]).toBe(second[0]);
		expect(first[1]).not.toBe(second[1]);
		expect(calls).toBe(3);
		const fixed = constant({ n: 1 });
		const watch = await fixed.watch(context);
		expect(watch.value).toBe(fixed.value);
		expect(await watch.stop()).toEqual({ kind: "stopped" });
	});
});
