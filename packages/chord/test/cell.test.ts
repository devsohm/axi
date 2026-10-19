import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { Type } from "typebox";
import { describe, it, vi } from "vitest";
import { Cell, Derived, HYDRATION, unhydrated } from "../src/cell.ts";
import { isChordError } from "../src/errors.ts";
import { enqueue, holdPublications } from "../src/publish.ts";
import { defineRegistry } from "../src/registry.ts";
import type { Ctx, StateEvent } from "../src/types.ts";

const ctx: Ctx = {
	signal: new AbortController().signal,
	rootId: "test",
	codeVersion: 1,
	principal: null,
	async get() {
		throw new Error("No host in this state test");
	},
};
const guard = () => {};
function fixture(dev = true) {
	const errors: unknown[] = [];
	return {
		errors,
		options: {
			dev,
			report: (error: unknown) => {
				errors.push(error);
			},
		},
	};
}

describe("object state", () => {
	it("does not retain a cell through its listener disposer", () => {
		const moduleUrl = new URL("../src/cell.ts", import.meta.url).href;
		const program = `
			import { Cell } from ${JSON.stringify(moduleUrl)};
			import { setImmediate } from 'node:timers/promises';
			function hold(method) {
				const cell = new Cell('n', { type: 'number' }, { value: 1 }, () => {}, { dev: false, report: () => {} });
				return { weak: new WeakRef(cell), dispose: cell[method](() => {}) };
			}
			const held = [hold('subscribe'), hold('events')];
			for (let i = 0; i < 16; i++) { await setImmediate(); globalThis.gc(); }
			console.log(JSON.stringify(held.map(({ weak, dispose }) => ({ collected: weak.deref() === undefined, removed: dispose() }))));
		`;
		const output = execFileSync(process.execPath, ["--expose-gc", "--input-type=module", "-e", program], {
			encoding: "utf8",
			timeout: 15000,
		});
		assert.deepEqual(JSON.parse(output), [
			{ collected: true, removed: true },
			{ collected: true, removed: true },
		]);
	});
	it("skips structure inspection for an explicit whole-value replacement", () => {
		const { options } = fixture(false);
		const schema = Type.Object({ item: Type.Object({ n: Type.Number() }) });
		const cell = new Cell("value", schema, { value: { item: { n: 1 } } }, guard, options);
		const next = { item: { n: 2 } };
		const events: StateEvent<typeof next>[] = [];
		cell.events((event) => events.push(event));
		const entries = vi.spyOn(Object, "entries");
		try {
			cell.replace(ctx, next, { diff: false });
			assert.equal(
				entries.mock.calls.some(([value]) => value === next),
				false,
			);
			assert.deepEqual(events[1], { type: "ops", ops: [["r", next]], value: next });
		} finally {
			entries.mockRestore();
		}
	});
	it("snapshots hydration sources before reading their metadata", () => {
		const reads: string[] = [];
		const source = (index: number) => ({
			get [HYDRATION]() {
				reads.push(`read${index}`);
				return { hydrated: false, whenHydrated: async () => {} };
			},
		});
		function* sources() {
			reads.push("yield1");
			yield source(1);
			reads.push("yield2");
			yield source(2);
		}
		assert.equal(unhydrated(sources()).length, 2);
		assert.deepEqual(reads, ["yield1", "yield2", "read1", "read2"]);
	});
	it("returns the listener deletion result from both subscription kinds", () => {
		const { options } = fixture();
		const cell = new Cell("n", Type.Number(), { value: 1 }, guard, options);
		for (const dispose of [cell.subscribe(() => {}), cell.events(() => {})]) {
			assert.equal(dispose(), true);
			assert.equal(dispose(), false);
		}
	});
	it("validates the first value and delays initialization without publishing", () => {
		const { options } = fixture();
		assert.throws(() => new Cell("n", Type.Number(), { value: "wrong" }, guard, options), /initial value/);
		const n = new Cell<number>("n", Type.Number(), undefined, guard, options);
		assert.throws(
			() => n.value,
			(error) => isChordError(error, "not_ready"),
		);
		assert.throws(() => n.subscribe(() => {}), /not_ready/);
		n.initialize(3);
		const values: number[] = [];
		n.subscribe((value) => values.push(value));
		assert.deepEqual(values, [3]);
		assert.throws(() => n.initialize(4), /already initialized/);
	});
	it("rejects foreign writes before invoking a mutation", () => {
		const { options } = fixture();
		const n = new Cell(
			"n",
			Type.Number(),
			{ value: 0 },
			() => {
				throw new Error("read only");
			},
			options,
		);
		let invoked = false;
		assert.throws(
			() =>
				n.change(ctx, () => {
					invoked = true;
				}),
			/read only/,
		);
		assert.equal(invoked, false);
		assert.equal(n.value, 0);
	});
	it("publishes exact primitive and nested changes and expires drafts", () => {
		const { options } = fixture();
		const n = new Cell("n", Type.Number(), { value: 0 }, guard, options);
		const events: StateEvent<number>[] = [];
		n.events((event) => events.push(event));
		n.change(ctx, (value) => value + 1);
		assert.deepEqual(events, [
			{ type: "snap", value: 0 },
			{ type: "ops", ops: [["r", 1]], value: 1 },
		]);
		assert.equal(JSON.stringify(events[1]), '{"type":"ops","ops":[["r",1]],"value":1}');
		const list = new Cell(
			"list",
			Type.Object({ items: Type.Array(Type.Number()) }),
			{ value: { items: [] as number[] } },
			guard,
			options,
		);
		let saved: number[] | undefined;
		list.change(ctx, (draft) => {
			saved = draft.items;
			draft.items.push(2);
		});
		assert.deepEqual(list.value, { items: [2] });
		assert.throws(() => saved!.push(3), /settled overlay/);
	});
	it("rolls back a failing derived value and publishes nothing", () => {
		const { options } = fixture();
		const n = new Cell("n", Type.Number(), { value: 1 }, guard, options);
		const doubled = new Derived<number>("double", [n], (value: number) => value * 2, options);
		doubled.schemas = [Type.Number({ maximum: 4 })];
		doubled.attach();
		const values: number[] = [];
		n.subscribe((value) => values.push(value));
		assert.throws(() => n.replace(ctx, 3), /invalid/);
		assert.equal(n.value, 1);
		assert.equal(doubled.value, 2);
		assert.deepEqual(values, [1]);
		n.replace(ctx, 2);
		assert.equal(doubled.value, 4);
	});
	it("adopts the entire graph before re-entrant notification", () => {
		const { options } = fixture();
		const n = new Cell("n", Type.Number(), { value: 0 }, guard, options);
		const doubled = new Derived<number>("double", [n], (value: number) => value * 2, options);
		const sum = new Derived<number>("sum", [n, doubled], (value: number, twice: number) => value + twice, options);
		doubled.attach();
		sum.attach();
		n.subscribe((value) => {
			if (value === 1) {
				assert.equal(sum.value, 3);
				n.replace(ctx, 2);
			}
		});
		const seen: number[][] = [[], [], []];
		[n, doubled, sum].forEach((source, i) => source.subscribe((value) => seen[i].push(value)));
		n.replace(ctx, 1);
		assert.deepEqual(seen, [
			[0, 1, 2],
			[0, 2, 4],
			[0, 3, 6],
		]);
		assert.equal(sum.value, 6);
	});
	it("always validates returned values while allowing unchecked replacement outside development", () => {
		const { options } = fixture(false);
		const list = new Cell("list", Type.Array(Type.Number()), { value: [] as number[] }, guard, options);
		assert.throws(() => list.change(ctx, (draft) => draft.push(1) as never), /invalid/);
		assert.deepEqual(list.value, []);
		list.replace(ctx, "unchecked" as never);
		assert.equal(list.value, "unchecked");
	});
	it("reports listener failures and respects subscriptions at publication time", () => {
		const { options, errors } = fixture();
		const n = new Cell("n", Type.Number(), { value: 0 }, guard, options);
		const values: number[] = [];
		n.subscribe(() => {
			throw new Error("observer");
		});
		const unsubscribe = n.subscribe((value) => values.push(value));
		holdPublications(() => {
			n.replace(ctx, 1);
			unsubscribe();
			n.subscribe((value) => values.push(value * 10));
		});
		assert.deepEqual(values, [0, 10]);
		assert.equal(errors.length, 2);
	});
	it("diffs structural replacements and emits reset even for the same value", () => {
		const { options } = fixture();
		const initial = { child: { n: 1 }, n: 0 };
		const state = new Cell(
			"s",
			Type.Object({ child: Type.Object({ n: Type.Number() }), n: Type.Number() }),
			{ value: initial },
			guard,
			options,
		);
		const events: StateEvent<typeof initial>[] = [];
		state.events((event) => events.push(event));
		state.replace(ctx, { ...initial, n: 2 });
		assert.deepEqual(events[1], { type: "ops", ops: [["s", ["n"], 2]], value: { child: { n: 1 }, n: 2 } });
		state.reset(state.value, state.schema);
		assert.equal(events[2].type, "reset");
	});
	it("tracks external hydration and stops external subscriptions on detach", async () => {
		const { options } = fixture();
		const external = new Cell("external", Type.Number(), { value: 2 }, guard, options);
		let subscribed = 0,
			hydrated = false;
		const source = {
			get value() {
				return external.value;
			},
			get [HYDRATION]() {
				return {
					hydrated,
					whenHydrated: async () => {
						hydrated = true;
					},
				};
			},
			subscribe(fn: (value: number) => void) {
				subscribed++;
				const off = external.subscribe(fn);
				return () => {
					subscribed--;
					off();
				};
			},
			events: external.events.bind(external),
		};
		const derived = new Derived<number>("external-double", [source], (value: number) => value * 2, options);
		assert.equal(unhydrated([null, derived]).length, 1);
		await derived[HYDRATION]!.whenHydrated();
		assert.equal(derived[HYDRATION], undefined);
		derived.attach();
		external.replace(ctx, 3);
		assert.equal(derived.value, 6);
		derived.detach();
		assert.equal(subscribed, 0);
		external.replace(ctx, 4);
		assert.equal(derived.value, 6);
	});
	it("rejects asynchronous callbacks without adopting their writes", () => {
		const { options } = fixture();
		const n = new Cell("n", Type.Number(), { value: 0 }, guard, options);
		assert.throws(() => n.change(ctx, async () => 1), /synchronous/);
		const derived = new Derived("async", [n], async () => 1, options);
		assert.throws(() => derived.attach(), /synchronous/);
		assert.equal(n.value, 0);
	});
});

it("defers nested publications and preserves FIFO order", () => {
	const seen: number[] = [];
	holdPublications(() => {
		enqueue(() => {
			seen.push(1);
			enqueue(() => {
				seen.push(3);
			});
		});
		holdPublications(() =>
			enqueue(() => {
				seen.push(2);
			}),
		);
		assert.deepEqual(seen, []);
	});
	assert.deepEqual(seen, [1, 2, 3]);
});

it("declares registry conflict handling without creating a runtime table", () => {
	assert.deepEqual(defineRegistry<number>("commands"), { name: "commands", conflict: "error" });
	assert.deepEqual(defineRegistry<number>("commands", { conflict: "last" }), { name: "commands", conflict: "last" });
});
