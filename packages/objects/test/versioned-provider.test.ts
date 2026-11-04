import { expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import {
	evolve,
	int,
	keyed,
	local,
	method,
	obj,
	str,
} from "../src/next/contracts/index.ts";
import { defineState } from "../src/next/documents/index.ts";
import { createHost, defineFacet } from "../src/next/host/index.ts";
import { constant } from "../src/next/state/index.ts";

it("serves older state, methods and keyed documents through one shared mapping", async () => {
	const first = local("counter.versioned", {
		version: 1,
		params: {},
		members: {
			total: int(),
			bump: method(int(), int()),
			rows: keyed(obj({ amount: int() })),
		},
	});
	const current = evolve(first, (e) =>
		e
			.state("total", obj({ n: int() }))
			.method("bump", obj({ amount: int() }), obj({ total: int() }))
			.keyed("rows", obj({ amount: int(), unit: str() })),
	);
	const Count = defineState("count", {
		schema: obj({ n: int() }),
		version: 1,
		initial: () => ({ n: 0 }),
	});
	const Rows = defineState("rows", {
		schema: obj({ amount: int(), unit: str() }),
		version: 1,
		keyed: true,
		initial: () => ({ amount: 0, unit: "items" }),
	});
	let mapped = 0;
	const host = createHost({ onError: () => {} });
	try {
		await host.load(
			[
				{
					name: "counter",
					facet: defineFacet((h) =>
						h.serve(
							current,
							(_, self) => {
								const count = self.state(Count),
									rows = self.state(Rows);
								return {
									total: count,
									rows,
									bump: async ({ amount }, ctx) => {
										await count.change((draft) => {
											draft.n += amount;
										}, ctx);
										await rows.change(
											"last",
											(draft) => {
												draft.amount = amount;
											},
											ctx,
										);
										return { total: count.value.n };
									},
								};
							},
							{
								accepts: {
									1: {
										state: {
											total: (value) => {
												mapped++;
												return value.n;
											},
										},
										methods: {
											bump: {
												args: (amount) => ({ amount }),
												result: (result) => result.total,
											},
										},
										keyed: { rows: (value) => ({ amount: value.amount }) },
									},
								},
							},
						),
					),
				},
			],
			context,
		);
		const a = await host.get(first, {}, context),
			b = await host.get(first, {}, context);
		const one = await a.total.watch(context),
			two = await b.total.watch(context);
		expect([one.value, two.value, mapped]).toEqual([0, 0, 1]);
		expect(await a.bump(4, context)).toBe(4);
		expect([a.total.value, b.total.value, mapped]).toEqual([4, 4, 2]);
		expect(await b.rows.get("last", context)).toEqual({ amount: 4 });
	} finally {
		await host.close(context);
	}
});

it("reports a refused older member while continuing to serve the current contract", async () => {
	const first = local("counter.refused", {
		version: 1,
		params: {},
		members: { value: int() },
	});
	const current = evolve(first, (e) =>
		e.removeState("value").addState("total", int()),
	);
	const host = createHost({ onError: () => {} });
	try {
		await host.load(
			[
				{
					name: "counter",
					facet: defineFacet((h) =>
						h.serve(current, () => ({ total: constant(8) }), {
							accepts: { 1: { state: { value: "refuse" } } },
						}),
					),
				},
			],
			context,
		);
		const currentRef = await host.get(current, {}, context),
			old = host.hold(first, {}, context);
		expect(currentRef.total.value).toBe(8);
		expect(old.state.value).toMatchObject({
			kind: "failed",
			cause: { kind: "waiting", error: { code: "contract_mismatch" } },
		});
		expect(host.references(current).value).toHaveLength(1);
		const failed = old.state.value;
		expect(old.state.value).toBe(failed);
	} finally {
		await host.close(context);
	}
});
