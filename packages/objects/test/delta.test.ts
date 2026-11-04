import { describe, expect, it } from "vitest";
import { ArrayLayout } from "../src/delta/array-layout.ts";
import {
	apply,
	applyImmutable,
	applyImmutableBatches,
	assertValidOp,
	assertValidWireOp,
	decoder,
	diffRevisions,
	encoder,
	type Op,
	track,
	UnsafePathError,
} from "../src/delta/index.ts";

describe("revision transactions", () => {
	it("reports draft properties as read-only while preparing their revision", () => {
		const descriptors: PropertyDescriptor[] = [];
		let inspect = (): void => {};
		const initial = new Proxy(
			{ count: 0 },
			{
				ownKeys(target) {
					inspect();
					return Reflect.ownKeys(target);
				},
			},
		);
		const tracker = track(initial);
		const change = tracker.beginChange();
		const draft = change.state;
		draft.count = 1;
		inspect = () => {
			const descriptor = Object.getOwnPropertyDescriptor(draft, "count");
			if (descriptor === undefined) throw new Error("Missing draft property");
			descriptors.push(descriptor);
		};
		const prepared = change.prepare();
		expect(descriptors).toEqual([{ value: 1, writable: false, enumerable: true, configurable: true }]);
		expect(prepared.ops).toEqual([["s", ["count"], 1]]);
		tracker.adopt(prepared);
		expect(tracker.value).toEqual({ count: 1 });
	});
	it("keeps an insertion source offset without copying its references", () => {
		const refs = [1, 1, 7, 8];
		const layout = new ArrayLayout(3);
		layout.insert(1, 1, refs, 2);
		const span = layout.spans[1];
		expect(span).toEqual({ kind: "insert", source: { refs: [1, 1, 7, 8] }, start: 2, length: 2, step: 1 });
		if (span.kind !== "insert") throw new Error("missing inserted range");
		expect(span.source.refs).toBe(refs);
		expect(layout.length).toBe(4);
		expect(layout.plan).toEqual({ removals: [1, 1], permutation: undefined, insertions: [1, 1, 2] });
	});
	it("preserves array mutator names and argument counts", () => {
		const change = track({ rows: [1, 2] }).beginChange();
		try {
			const names = ["push", "pop", "shift", "unshift", "splice", "reverse", "sort", "fill", "copyWithin"] as const;
			expect(names.map((name) => [change.state.rows[name].name, change.state.rows[name].length])).toEqual([
				["push", 0],
				["pop", 0],
				["shift", 0],
				["unshift", 0],
				["splice", 0],
				["reverse", 0],
				["sort", 1],
				["fill", 3],
				["copyWithin", 3],
			]);
		} finally {
			change.abort();
		}
	});

	it("checks a borrowed mutator receiver before applying the native operation", () => {
		const change = track({ rows: [] as number[] }).beginChange();
		let symbolReads = 0;
		const receiver = new Proxy([] as number[], {
			get(target, key, receiver) {
				if (typeof key === "symbol") symbolReads++;
				return Reflect.get(target, key, receiver);
			},
		});
		const length = Reflect.apply(change.state.rows.push, receiver, [7]);
		expect(symbolReads).toBe(1);
		expect(length).toBe(1);
		expect(receiver).toEqual([7]);
		change.abort();
	});
	it("preserves operation order when a dense region and a neighboring object both change", () => {
		const change = track({ rows: Array.from({ length: 400 }, (_, id) => ({ id })), meta: { n: 0 } }).beginChange();
		for (let i = 0; i < 256; i++) change.state.rows[i].id = -i - 1;
		change.state.meta.n++;
		const ready = change.prepare();
		expect(ready.ops).toEqual([
			["s", ["meta", "n"], 1],
			["p", ["rows"], 0, 256, Array.from({ length: 256 }, (_, i) => ({ id: -i - 1 }))],
		]);
		expect(ready.value.meta.n).toBe(1);
		expect(ready.value.rows[255]).toEqual({ id: -256 });
		expect(ready.value.rows[256]).toEqual({ id: 256 });
	});
	it("combines adjacent insertions from separate sources into one operation", () => {
		const change = track({ rows: [{ id: "x" }, { id: "y" }] }).beginChange();
		change.state.rows.splice(1, 0, { id: "a" });
		change.state.rows.splice(1, 0, { id: "b" });
		change.state.rows.splice(2, 0, { id: "c" });
		const ready = change.prepare();
		expect(ready.ops).toEqual([["p", ["rows"], 1, 0, [{ id: "b" }, { id: "c" }, { id: "a" }]]]);
		expect(ready.value.rows).toEqual([{ id: "x" }, { id: "b" }, { id: "c" }, { id: "a" }, { id: "y" }]);
	});
	it("materializes a large object batch without changing unmodified containers", () => {
		const base = {
			entries: Object.fromEntries(Array.from({ length: 129 }, (_, i) => [i, { n: 0 }])),
			stable: { id: 1 },
		};
		const change = track(base).beginChange();
		for (let i = 0; i < 129; i++) change.state.entries[i].n = i + 1;
		const ready = change.prepare();
		expect(ready.value.entries[0]).toEqual({ n: 1 });
		expect(ready.value.entries[128]).toEqual({ n: 129 });
		expect(ready.value.stable).toBe(base.stable);
		expect(base.entries[128]).toEqual({ n: 0 });
		expect(applyImmutable(base, ready.ops)).toEqual(ready.value);
	});
	it("retains one compact range when reversing a large untouched array", () => {
		const layout = new ArrayLayout(1_000_000);
		layout.reverse();
		expect(layout.spans).toHaveLength(1);
		expect(layout.locate(0)).toEqual({ kind: "base", start: 999_999, length: 1_000_000, step: -1 });
		expect(layout.offset).toBe(0);
		expect(layout.locate(999_999)).toBe(layout.spans[0]);
		expect(layout.offset).toBe(999_999);
		expect(layout.indexOf(400_000)).toBe(599_999);
		layout.reverse();
		expect(layout.locate(400_000)).toEqual({ kind: "base", start: 0, length: 1_000_000, step: 1 });
		expect(layout.offset).toBe(400_000);
	});
	it("stores primitive insertions directly and reuses a plan until the layout changes", () => {
		const layout = new ArrayLayout(3);
		layout.insert(1, 0, [null, false, 2, "x"]);
		expect(layout.spans).toEqual([
			{ kind: "base", start: 0, length: 1, step: 1 },
			{ kind: "insert", source: { refs: [null, false, 2, "x"] }, start: 0, length: 4, step: 1 },
			{ kind: "base", start: 1, length: 2, step: 1 },
		]);
		const plan = layout.plan;
		expect(plan).toEqual({ removals: [], permutation: undefined, insertions: [1, 1, 2] });
		layout.locate(3);
		expect(layout.plan).toBe(plan);
		expect(layout.generation).toBe(1);
		layout.reverse();
		expect(layout.generation).toBe(2);
		expect(layout.plan).not.toBe(plan);
		expect(layout.plan).toEqual({ removals: [], permutation: [2, 1, 0], insertions: [2, 1, 2] });
	});
	it("keeps held rows attached through reversed ranges, splits and insertions", () => {
		const store = track({ rows: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }] });
		const change = store.beginChange(),
			rows = change.state.rows;
		const held = rows[1];
		rows.reverse();
		rows.splice(1, 1, { id: "x" }, { id: "y" });
		rows.reverse();
		rows.push({ id: "last" });
		held.id = "held";
		const ready = change.prepare();
		expect(ready.value.rows).toEqual([
			{ id: "a" },
			{ id: "held" },
			{ id: "y" },
			{ id: "x" },
			{ id: "d" },
			{ id: "last" },
		]);
		expect(applyImmutable(ready.base, ready.ops)).toEqual(ready.value);
		store.adopt(ready);
		expect(store.value.rows[1].id).toBe("held");
	});
	it("locates inserted rows after splitting and reversing several insertion sources", () => {
		const store = track({ rows: [] as { id: string }[] });
		const change = store.beginChange(),
			rows = change.state.rows;
		rows.push({ id: "a" }, { id: "b" }, { id: "c" });
		const held = rows[1];
		rows.unshift({ id: "front" });
		rows.reverse();
		rows.splice(2, 0, { id: "middle" });
		rows.reverse();
		held.id = "held";
		rows.splice(1, 1);
		const ready = change.prepare();
		expect(ready.value.rows).toEqual([{ id: "front" }, { id: "middle" }, { id: "held" }, { id: "c" }]);
		expect(applyImmutable(ready.base, ready.ops)).toEqual(ready.value);
	});
	it.each(["change", "replacement"])("can abort a prepared %s after another candidate wins", (kind) => {
		const store = track({ value: 0 });
		const change = store.beginChange();
		change.state.value = 1;
		const loser = kind === "change" ? change.prepare() : store.prepareReplace({ value: 1 });
		store.adopt(store.prepareReplace({ value: 2 }));
		loser.abort();
		expect(() => store.adopt(loser)).toThrow("Prepared change has been aborted");
		expect(store.value).toEqual({ value: 2 });
		expect(store.revision).toBe(1);
		const stale = store.prepareReplace({ value: 3 });
		store.adopt(store.prepareReplace({ value: 4 }));
		expect(() => store.adopt(stale)).toThrow("Prepared change is stale");
		stale.abort();
		expect(() => store.adopt(stale)).toThrow("Prepared change is stale");
	});
	it("keeps no-op edits from changing the order of later operation batches", () => {
		const change = track({ rows: [1, 2], metadata: { count: 0 } }).beginChange();
		change.state.rows.sort((a, b) => a - b);
		change.state.rows[0] = 1;
		change.state.metadata.count = 1;
		change.state.rows.push(3);
		expect(change.prepare().ops).toEqual([
			["s", ["metadata", "count"], 1],
			["p", ["rows"], 2, 0, [3]],
		]);
	});
	it("prepares privately, publishes by adoption, and preserves earlier publications", async () => {
		const original = { label: "queued", rows: [{ count: 1 }], stable: { id: "keep" } };
		const store = track(original);
		const change = store.beginChange();
		change.state.label = "queued!";
		await Promise.resolve();
		change.state.rows[0].count = 2;
		const ready = change.prepare();
		expect(store.value).toBe(original);
		expect(ready.value).toEqual({ label: "queued!", rows: [{ count: 2 }], stable: { id: "keep" } });
		expect(ready.value.stable).toBe(original.stable);
		store.adopt(ready);
		const next = store.prepareReplace({ label: "done", rows: [], stable: { id: "next" } });
		store.adopt(next);
		expect(original.rows).toEqual([{ count: 1 }]);
		expect(ready.value.rows).toEqual([{ count: 2 }]);
		expect(store.value.label).toBe("done");
	});

	it("rejects a whole invalid placement before inserting any values or invoking accessors", () => {
		const store = track({ rows: [{ n: 1 }] });
		const change = store.beginChange();
		let calls = 0;
		const invalid = Object.defineProperty({}, "n", {
			enumerable: true,
			get() {
				calls++;
				return 3;
			},
		});
		expect(() => change.state.rows.push({ n: 2 }, invalid as { n: number })).toThrow(TypeError);
		expect(calls).toBe(0);
		expect(change.state.rows).toEqual([{ n: 1 }]);
		change.abort();
	});

	it("keeps moved handles attached and discards changes to removed values", () => {
		const store = track({ rows: [{ id: "a" }, { id: "b" }] });
		const change = store.beginChange();
		const held = change.state.rows[1];
		change.state.rows.unshift({ id: "front" });
		held.id = "moved";
		expect(change.state.rows.map((row) => row.id)).toEqual(["front", "a", "moved"]);
		change.state.rows.pop();
		held.id = "removed";
		const ready = change.prepare();
		expect(ready.value.rows).toEqual([{ id: "front" }, { id: "a" }]);
		expect(applyImmutable(ready.base, ready.ops)).toEqual(ready.value);
		expect(() => held.id).toThrow(TypeError);
	});

	it("normalizes an equal assignment but still advances the revision and expires competitors", () => {
		const original = { nested: { a: 1, b: 2 } };
		const store = track(original);
		const loser = store.beginChange();
		const held = loser.state.nested;
		const winner = store.beginChange();
		winner.state.nested = { b: 2, a: 1 };
		const ready = winner.prepare();
		expect(ready.ops).toEqual([]);
		store.adopt(ready);
		expect(store.value).toBe(original);
		expect(store.revision).toBe(1);
		expect(() => held.a).toThrow(TypeError);
		expect(() => loser.prepare()).toThrow(/settled/);
		expect(() => store.adopt(ready)).toThrow(/already been used/);
	});
});

describe("replica boundaries", () => {
	it("reports a nonnumeric array path before checking for an own property", () => {
		expect(() => apply([], [["s", ["missing", "value"], 1]])).toThrow("unsafe path segment: missing");
		expect(() => applyImmutable([], [["s", ["missing", "value"], 1]])).toThrow('unresolvable path: ["missing"]');
	});

	it("validates an inline decoder path once", () => {
		let scans = 0;
		const path = ["text"];
		path[Symbol.iterator] = function* () {
			scans++;
			yield "text";
			return undefined;
		};
		const operations = decoder().decode([["a", path, "!"]]);
		expect(scans).toBe(1);
		expect(operations).toHaveLength(1);
		expect(operations[0][0]).toBe("a");
		expect(operations[0][1]).toBe(path);
		expect(operations).toEqual([["a", path, "!"]]);
	});

	it("keeps subsequence removals in output order", () => {
		expect(diffRevisions([0, 1, 2, 3, 4, 5, 6], [1, 4])).toEqual([
			["p", [], 0, 1, []],
			["p", [], 1, 2, []],
			["p", [], 2, 2, []],
		]);
	});

	it("keeps rows aligned through shared child containers", () => {
		const children = [{ id: 1 }, { id: 2 }, { id: 3 }];
		const before = children.map((child) => ({ child, n: 1 }));
		const after = children.map((child) => ({ child, n: 2 }));
		expect(diffRevisions(before, after)).toEqual([
			["s", [0, "n"], 2],
			["s", [1, "n"], 2],
			["s", [2, "n"], 2],
		]);
	});

	it("stops reading later values after the operation budget overflows", () => {
		const before: Record<string, number> = {};
		const after: Record<string, number> = {};
		for (let i = 0; i < 4097; i++) {
			before[`key${i}`] = 0;
			after[`key${i}`] = 1;
		}
		let reads = 0;
		Object.defineProperty(after, "later", {
			enumerable: true,
			get() {
				reads++;
				return 2;
			},
		});
		const operations = diffRevisions(before, after);
		expect(reads).toBe(0);
		expect(operations).toHaveLength(1);
		expect(operations[0][0]).toBe("r");
		expect(operations[0][1]).toBe(after);
	});

	it("reports tuple shape errors before inspecting malformed paths", () => {
		expect(() => assertValidOp(["a", [], null])).toThrow("a shape");
		expect(() => assertValidOp(["t", ["constructor"], -1])).toThrow("t shape");
		expect(() => assertValidWireOp(["p", ["constructor"], 0, 0, undefined])).toThrow("p arity");
	});
	it("replays a backlog without consuming shared frozen inputs", () => {
		const payload = Object.freeze({ n: 2 });
		const base = Object.freeze({ rows: Object.freeze([{ n: 1 }]), text: "abcdef" });
		const batches: Op[][] = [
			[["p", ["rows"], 1, 0, [payload]]],
			[
				["s", ["rows", 1, "n"], 3],
				["t", ["text"], 2],
			],
		];
		expect(applyImmutableBatches(base, batches)).toEqual({ rows: [{ n: 1 }, { n: 3 }], text: "cdef" });
		expect(payload.n).toBe(2);
		expect(base.rows).toEqual([{ n: 1 }]);
	});

	it("starts an independently recoverable stream at each root replacement", () => {
		const writer = encoder(),
			reader = decoder();
		reader.decode(writer.encode([["a", ["text"], "1"]]));
		reader.decode(writer.encode([["a", ["text"], "2"]]));
		const reset = writer.encode([["r", { text: "reset" }]]);
		const later = writer.encode([
			["a", ["text"], "!"],
			["a", ["text"], "?"],
		]);
		const fresh = decoder();
		const value = apply<{ text: string }>(undefined, fresh.decode(reset));
		expect(apply(value, fresh.decode(later))).toEqual({ text: "reset!?" });
		expect(() => fresh.decode([["a", 0, "stale"]])).toThrow();
	});

	it("rejects unsafe paths before reading the input object", () => {
		let calls = 0;
		const target = Object.defineProperty({}, "trap", {
			enumerable: true,
			get() {
				calls++;
				return {};
			},
		});
		expect(() => applyImmutable(target, [["s", ["trap", "constructor"], true]])).toThrow(UnsafePathError);
		expect(calls).toBe(0);
		expect(() => apply({ rows: [] }, [["s", ["rows", 5], 1]])).toThrow(UnsafePathError);
	});

	it("keeps a structural diff exact across a reorder and later edit", () => {
		const first = { id: "a" },
			second = { id: "b" };
		const before = { rows: [first, second], text: "start" };
		const after = { rows: [second, first], text: "start!" };
		const operations = diffRevisions(before, after);
		expect(applyImmutable(before, operations)).toEqual({ rows: [{ id: "b" }, { id: "a" }], text: "start!" });
		expect(before.rows).toEqual([{ id: "a" }, { id: "b" }]);
	});
});
