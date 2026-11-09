import { expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import { constant, createHost, defineFacet, local, method, str } from "../src/index.ts";
import { ObjectsHost } from "../src/host/host.ts";

it("finishes calls and their nested work on the outgoing code while new calls wait", async () => {
	const Work = local("drain.work", { version: 1, params: {}, members: { run: method(undefined, str()) } });
	const Dep = local("drain.dep", { version: 1, params: {}, members: { value: method(undefined, str()) } });
	const entered = Promise.withResolvers<void>();
	const enteredDep = Promise.withResolvers<void>();
	const releaseDep = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	const build = (label: string) =>
		defineFacet((h) => {
			h.serve(Dep, () => ({
				value: async () => {
					if (label === "before") {
						enteredDep.resolve();
						await releaseDep.promise;
					}
					return label;
				},
			}));
			h.serve(Work, (_, self) => {
				const dep = self.get(Dep, {});
				return {
					run: async (ctx) => {
						if (label === "before") {
							entered.resolve();
							await finish.promise;
						}
						return `${label}:${await dep.value(ctx)}`;
					},
				};
			});
		});
	const host = createHost({ onError: () => {} });
	try {
		await host.load([{ name: "work", facet: build("before") }], context);
		const ref = await host.get(Work, {}, context);
		const dep = await host.get(Dep, {}, context);
		const holding = dep.value(context);
		void holding.catch(() => {});
		await enteredDep.promise;
		const running = ref.run(context);
		void running.catch(() => {});
		await entered.promise;
		const report = await host.reload([{ name: "work", facet: build("after") }], context);
		expect(report.objects.map(({ kind }) => kind)).toEqual(["restarted", "restarted"]);
		let settled = false;
		const next = ref.run(context).then((value) => {
			settled = true;
			return value;
		});
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(settled).toBe(false);
		finish.resolve();
		await new Promise((resolve) => setTimeout(resolve, 5));
		releaseDep.resolve();
		expect(await holding).toBe("before");
		expect(await running).toBe("before:before");
		expect(await next).toBe("after:after");
	} finally {
		finish.resolve();
		releaseDep.resolve();
		await host.close(context);
	}
});

it("rejects an outgoing call when the successor's opener waits on that same call's drain", async () => {
	const Service = local("cycle.service", {
		version: 1,
		params: {},
		members: { begin: method(undefined, str()), ping: method(undefined, str()) },
	});
	const View = local("cycle.view", { version: 1, params: {}, members: { show: method(undefined, str()) } });
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const facet = (updated: boolean) =>
		defineFacet((h) => {
			h.serve(Service, () => ({
				begin: async (ctx) => {
					entered.resolve();
					await release.promise;
					return (await ctx.get(View, {})).show(ctx);
				},
				ping: async () => "pong",
			}));
			h.serve(View, (_, self) => {
				const service = self.get(Service, {});
				if (updated)
					self.open(
						(ctx) => service.ping(ctx),
						() => {},
					);
				return { show: async () => "view" };
			});
		});
	const host = new ObjectsHost({ onError: () => {}, reloadDrainTimeout: 200 });
	try {
		await host.load([{ name: "cycle", facet: facet(false) }], context);
		const service = await host.get(Service, {}, context);
		await host.get(View, {}, context);
		const outcome = service.begin(context).catch((error: unknown) => error);
		await entered.promise;
		await host.reload([{ name: "cycle", facet: facet(true) }], context);
		release.resolve();
		expect(await outcome).toMatchObject({ code: "unavailable", reason: "reload_cycle" });
	} finally {
		release.resolve();
		await host.close(context);
	}
});

it("caps the reload drain and publishes new code after cutting off a stuck call", async () => {
	const Slow = local("drain.slow", { version: 1, params: {}, members: { run: method(undefined, str()) } });
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const events: string[] = [];
	const host = new ObjectsHost({
		onError: (event) => {
			events.push(event.kind);
		},
		closeTimeout: 40,
		reloadDrainTimeout: 10,
	});
	expect(host.timeouts.reload).toBe(10);
	const facet = (updated: boolean) =>
		defineFacet((h) =>
			h.serve(Slow, () => ({
				run: async () => {
					if (!updated) {
						entered.resolve();
						await release.promise;
					}
					return updated ? "new" : "old";
				},
			})),
		);
	try {
		await host.load([{ name: "slow", facet: facet(false) }], context);
		const ref = await host.get(Slow, {}, context);
		const outcome = ref.run(context).catch((error: unknown) => error);
		await entered.promise;
		await host.reload([{ name: "slow", facet: facet(true) }], context);
		expect(await outcome).toMatchObject({ code: "released" });
		expect(await ref.run(context)).toBe("new");
		expect(events.filter((kind) => kind === "drain_timeout")).toHaveLength(1);
	} finally {
		release.resolve();
		await host.close(context);
	}
});

it("restarts a state-only factory while the reload report returns before activation", async () => {
	const Value = local("drain.value", { version: 1, params: {}, members: { text: str() } });
	let opened = 0;
	const build = () => defineFacet((h) => h.serve(Value, () => ({ text: constant(String(++opened)) })));
	const host = createHost({ onError: () => {} });
	try {
		await host.load([{ name: "value", facet: build() }], context);
		const ref = await host.get(Value, {}, context);
		const result = await host.reload([{ name: "value", facet: build() }], context);
		expect(result.objects).toEqual([{ object: Value.name, kind: "restarted" }]);
		await vi.waitFor(() => expect(ref.text.value).toBe(String(opened)));
		expect(ref.state.value.kind).toBe("live");
	} finally {
		await host.close(context);
	}
});
