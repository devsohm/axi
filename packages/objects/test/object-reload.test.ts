import { expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as context, type Context, withCancel } from "../src/context/index.ts";
import { ObjectsHost } from "../src/next/host/host.ts";
import {
	createHost,
	constant,
	defineFacet,
	defineJob,
	defineState,
	evolve,
	int,
	local,
	method,
	obj,
	str,
	unknown,
} from "../src/next/index.ts";

const Total = local("reload.total", {
	version: 1,
	params: {},
	members: { total: obj({ n: int() }), add: method(int(), int()) },
});
const Count = defineState("count", { version: 1, schema: obj({ n: int() }), initial: () => ({ n: 5 }) });

it("keeps installed code after staging fails and carries documents into a pure swap", async () => {
	const host = createHost({ onError: () => {} });
	const plugin = (factor: number) =>
		defineFacet((h) =>
			h.serve(Total, (_, self) => {
				const total = self.state(Count);
				return {
					total,
					add: (n: number, ctx: Context) =>
						self.tx(async (tx) => {
							const draft = await tx.draft(total);
							draft.n += n * factor;
							return draft.n;
						}, ctx),
				};
			}),
		);
	try {
		await host.load([{ name: "counter", facet: plugin(1) }], context);
		const ref = await host.get(Total, {}, context);
		await ref.add(3, context);
		const broken = defineFacet(() => {
			throw new Error("invalid setup");
		});
		const failed = await host.reload([{ name: "counter", facet: broken }], context);
		expect(failed.failed).toEqual([
			{ plugin: "counter", error: expect.objectContaining({ message: expect.stringContaining("invalid setup") }) },
		]);
		expect(ref.total.value).toEqual({ n: 8 });
		const result = await host.reload([{ name: "counter", facet: plugin(3) }], context);
		expect(result.objects).toEqual([{ object: "reload.total", kind: "swapped" }]);
		await ref.add(3, context);
		expect(ref.total.value).toEqual({ n: 17 });
	} finally {
		await host.close(context);
	}
});

it("loads healthy plugins beside failed ones and applies independent reloads", async () => {
	const Status = local("reload.status", { version: 1, params: {}, members: { value: int() } });
	const value = (n: number) => defineFacet((host) => host.serve(Status, () => ({ value: constant(n) })));
	const broken = defineFacet(() => {
		throw new Error("setup unavailable");
	});
	const host = createHost({ onError: () => {} });
	try {
		const initial = await host.load(
			[
				{ name: "broken", facet: broken },
				{ name: "status", facet: value(4) },
			],
			context,
		);
		expect(initial.failed.map(({ plugin }) => plugin)).toEqual(["broken"]);
		const ref = await host.get(Status, {}, context);
		const updated = await host.reload(
			[
				{ name: "broken", facet: broken },
				{ name: "status", facet: value(7) },
			],
			context,
		);
		expect(updated.failed.map(({ plugin }) => plugin)).toEqual(["broken"]);
		expect(updated.plugins.changed).toEqual(["status"]);
		expect(ref.value.value).toBe(7);
	} finally {
		await host.close(context);
	}
});

it("keeps a changed consumer when its provider cannot supply the new contract", async () => {
	const Earlier = local("reload.provider", { version: 1, params: {}, members: { value: int() } });
	const Later = local("reload.provider", { version: 2, params: {}, members: { value: int() } });
	const View = local("reload.view", { version: 1, params: {}, members: { label: str() } });
	const provider = defineFacet((host) => host.serve(Earlier, () => ({ value: constant(4) })));
	const view = (type: typeof Earlier | typeof Later, label: string) =>
		defineFacet((host) =>
			host.serve(View, (_, self) => ({ label: self.derive([self.get(type, {}).value], ([n]) => `${label}${n}`) })),
		);
	const host = createHost({ onError: () => {} });
	try {
		await host.load(
			[
				{ name: "provider", facet: provider },
				{ name: "view", facet: view(Earlier, "old ") },
			],
			context,
		);
		const ref = await host.get(View, {}, context);
		const result = await host.reload(
			[
				{ name: "provider", facet: provider },
				{ name: "view", facet: view(Later, "new ") },
			],
			context,
			{ failed: [{ plugin: "provider", error: new Error("new build failed") }] },
		);
		expect(result.failed.map(({ plugin }) => plugin)).toEqual(["provider", "view"]);
		expect(result.plugins.changed).toEqual([]);
		expect(ref.label.value).toBe("old 4");
	} finally {
		await host.close(context);
	}
});

it("reports the applied plugins and preserves their publication when cancellation follows the commit", async () => {
	const Status = local("reload.cancelled", { version: 1, params: {}, members: { label: str() } });
	const plugin = (label: string) => defineFacet((host) => host.serve(Status, () => ({ label: constant(label) })));
	const host = new ObjectsHost({ onError: () => {} });
	const { context: cancelled, cancel } = withCancel(context);
	await host.load([{ name: "status", facet: plugin("earlier") }], context);
	const ref = await host.get(Status, {}, context);
	const commit = host.batch.commit.bind(host.batch);
	const hook = vi.spyOn(host.batch, "commit").mockImplementation((apply, current) => {
		commit(apply, current);
		if (current === cancelled) cancel(new Error("caller left"));
	});
	try {
		await expect(host.reload([{ name: "status", facet: plugin("later") }], cancelled)).rejects.toMatchObject({
			code: "aborted",
			details: { committed: { added: [], changed: ["status"], removed: [], failed: [] } },
		});
		expect(ref.label.value).toBe("later");
	} finally {
		hook.mockRestore();
		await host.close(context);
	}
});

it("restores a parameterized object after its only reference waits for an older version", async () => {
	const First = local("reload.row", {
		version: 1,
		params: { slot: int() },
		members: { count: int(), set: method(int()) },
	});
	const Second = evolve(First, (edit) => edit.state("count", obj({ n: int() })));
	const plugin = (accept: boolean) =>
		defineFacet((h) =>
			h.serve(
				Second,
				(_, self) => {
					const count = self.state(Count);
					return {
						count,
						set: (n: number, ctx: Context) =>
							self.tx(async (tx) => {
								(await tx.draft(count)).n = n;
								return null;
							}, ctx),
					};
				},
				accept ? { accepts: { 1: { state: { count: (value) => value.n } } } } : {},
			),
		);
	const host = createHost({ onError: () => {} });
	try {
		await host.load([{ name: "rows", facet: plugin(true) }], context);
		const ref = await host.get(First, { slot: 8 }, context);
		await ref.set(12, context);
		await host.reload([{ name: "rows", facet: plugin(false) }], context);
		expect(ref.count.value).toBe(12);
		expect(ref.state.value.kind).toBe("failed");
		await host.reload([{ name: "rows", facet: plugin(true) }], context);
		await ref.set(21, context);
		expect(ref.count.value).toBe(21);
	} finally {
		await host.close(context);
	}
});

it("closes native resources with the reload reason and keeps the last visible value during reopening", async () => {
	const host = createHost({ onError: () => {} });
	const gate = Promise.withResolvers<void>(),
		closed: string[] = [];
	const plugin = (opening: Promise<void>) =>
		defineFacet((h) =>
			h.serve(Total, (_, self) => {
				const total = self.state(Count);
				self.open(
					async () => {
						await opening;
						return 1;
					},
					(_value, reason) => {
						closed.push(reason.kind);
					},
				);
				return { total, add: async () => 0 };
			}),
		);
	try {
		await host.load([{ name: "native", facet: plugin(Promise.resolve()) }], context);
		const ref = await host.get(Total, {}, context);
		expect(ref.total.value).toEqual({ n: 5 });
		const report = await host.reload([{ name: "native", facet: plugin(gate.promise) }], context);
		expect(report.objects[0]?.kind).toBe("restarted");
		await vi.waitFor(() => expect(closed).toEqual(["reload"]));
		expect(ref.total.value).toEqual({ n: 5 });
		gate.resolve();
		await vi.waitFor(() => expect(ref.state.value.kind).toBe("live"));
	} finally {
		gate.resolve();
		await host.close(context);
	}
	expect(closed).toEqual(["reload", "close"]);
});

it("finishes an older job on its original code and maps the outcome for the replacement", async () => {
	const Work = defineJob("reload.work", { version: 1, args: obj({ value: int() }), result: int() });
	const Updated = defineJob("reload.work", {
		version: 2,
		args: obj({ value: int(), priority: int() }),
		result: obj({ total: int() }),
		accepts: {
			1: { args: (old: { value: number }) => ({ ...old, priority: 2 }), result: (old: number) => ({ total: old }) },
		},
	});
	const Runner = local("reload.runner", {
		version: 1,
		params: {},
		members: { start: method(int(), str()), jobs: unknown() },
	});
	const gate = Promise.withResolvers<void>(),
		finished: unknown[] = [];
	const host = createHost({ onError: () => {} });
	const first = defineFacet((h) =>
		h.serve(Runner, (_, self) => {
			const work = self.job(Work, {
				run: async ({ value }) => {
					await gate.promise;
					return value + 1;
				},
			});
			return {
				start: async (value: number, ctx: Context) => (await work.start({ value }, ctx)).id,
				jobs: work.running,
			};
		}),
	);
	const next = defineFacet((h) =>
		h.serve(Runner, (_, self) => {
			const work = self.job(Updated, {
				run: async ({ value }) => ({ total: value * 2 }),
				finish: (outcome) => {
					finished.push(outcome);
				},
			});
			return {
				start: async (value: number, ctx: Context) => (await work.start({ value, priority: 1 }, ctx)).id,
				jobs: work.running,
			};
		}),
	);
	try {
		await host.load([{ name: "worker", facet: first }], context);
		const ref = await host.get(Runner, {}, context);
		await ref.start(10, context);
		await host.reload([{ name: "worker", facet: next }], context);
		expect(ref.jobs.value).toMatchObject([{ args: { value: 10, priority: 2 } }]);
		gate.resolve();
		await vi.waitFor(() =>
			expect(finished).toMatchObject([{ kind: "done", args: { value: 10, priority: 2 }, result: { total: 11 } }]),
		);
	} finally {
		gate.resolve();
		await host.close(context);
	}
});
