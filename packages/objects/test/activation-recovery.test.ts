import { expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT as context, awaitWithContext, type Context } from "../src/context/index.ts";
import { constant, createHost, defineFacet, int, local, method } from "../src/index.ts";

test.each([1, 2, 3])(
	"a %s-object dependency cycle rejects and repaired providers recover through explicit retries",
	async (length) => {
		const contracts = Array.from({ length }, (_, index) =>
			local(`activation.cycle${index}`, {
				version: 1,
				params: {},
				members: { value: int() },
			}),
		);
		const at = (index: number) => {
			const contract = contracts[index];
			if (!contract) throw new Error(`Missing fixture contract ${index}`);
			return contract;
		};
		const host = createHost({ readyTimeout: 1000, onError() {} });
		const facet = (repaired: boolean) =>
			defineFacet((h) => {
				for (const [index, contract] of contracts.entries())
					h.serve(contract, (_params, self) => {
						if (repaired && index === length - 1) return { value: constant(9) };
						const next = self.get(at((index + 1) % length), {});
						return { value: self.derive([next.value], ([value]) => value + 1) };
					});
			});
		await host.load([{ name: "chain", facet: facet(false) }], context);
		const refs = contracts.map((contract) => host.hold(contract, {}, context));
		try {
			for (const ref of refs) {
				await vi.waitFor(() => expect(ref.state.value.kind).toBe("failed"));
				expect(ref.state.value).toMatchObject({
					kind: "failed",
					cause: { error: { code: "invalid", reason: "cycle" } },
				});
			}
			refs[0]?.retry();
			await vi.waitFor(() => expect(refs[0]?.state.value.kind).toBe("failed"));
			await host.reload([{ name: "chain", facet: facet(true) }], context);
			for (const ref of [...refs].reverse()) {
				ref.retry();
				await vi.waitFor(() => expect(ref.state.value).toMatchObject({ kind: "live" }));
			}
			for (const [index, ref] of refs.entries()) {
				await vi.waitFor(() => expect(ref.state.value).toMatchObject({ kind: "live" }));
				expect(ref.value.value).toBe(9 + length - index - 1);
			}
		} finally {
			for (const ref of refs) ref.release();
			await host.close(context);
		}
	},
);

test("reload replaces a consumer parked on a failed dependency and binds its new derived state", async () => {
	const Provider = local("activation.provider", { version: 1, params: {}, members: { value: int() } });
	const Consumer = local("activation.consumer", { version: 1, params: {}, members: { value: int() } });
	const host = createHost({ onError() {} });
	const facet = (enabled: boolean) =>
		defineFacet((h) => {
			h.serve(Provider, (_params, self) => {
				self.open(
					async () => {
						if (!enabled) throw new Error("dependency unavailable");
						return null;
					},
					() => {},
				);
				return { value: constant(5) };
			});
			h.serve(Consumer, (_params, self) => {
				const provider = self.get(Provider, {});
				return { value: self.derive([provider.value], ([value]) => value + (enabled ? 2 : 1)) };
			});
		});
	await host.load([{ name: "application", facet: facet(false) }], context);
	const consumer = host.hold(Consumer, {}, context);
	try {
		await vi.waitFor(() => expect(consumer.state.value.kind).toBe("failed"));
		expect(consumer.state.value).toMatchObject({ kind: "failed", cause: { error: { code: "unavailable" } } });
		await host.reload([{ name: "application", facet: facet(true) }], context);
		await vi.waitFor(() => expect(consumer.state.value.kind).toBe("live"));
		expect(consumer.value.value).toBe(7);
	} finally {
		consumer.release();
		await host.close(context);
	}
});

test("reload cancels an unfinished opener and pending calls use the successor", async () => {
	const Service = local("activation.pending", {
		version: 1,
		params: { id: int() },
		members: { run: method(undefined, int()) },
	});
	const opened = Promise.withResolvers<Context>(),
		release = Promise.withResolvers<void>();
	const host = createHost({ onError() {} });
	const facet = (version: number) =>
		defineFacet((h) =>
			h.serve(Service, (_params, self) => {
				self.open(
					async (ctx) => {
						if (version === 1) {
							opened.resolve(ctx);
							await awaitWithContext(release.promise, ctx);
						}
						return version;
					},
					() => {},
				);
				return { run: async () => version };
			}),
		);
	await host.load([{ name: "service", facet: facet(1) }], context);
	const ref = host.hold(Service, { id: 1 }, context);
	const pending = ref.run(context),
		observed = Promise.allSettled([pending]);
	try {
		const old = await opened.promise;
		await host.reload([{ name: "service", facet: facet(2) }], context);
		expect(await pending).toBe(2);
		expect(old.abortSignal?.aborted).toBe(true);
		expect(old.abortSignal?.reason).toMatchObject({ code: "released", reason: "ended" });
		expect(await ref.run(context)).toBe(2);
	} finally {
		release.resolve();
		ref.release();
		await host.close(context);
		await observed;
	}
});

test("closing during activation cancels the opener and rejects its pending call", async () => {
	const Service = local("activation.closing", {
		version: 1,
		params: { id: int() },
		members: { run: method(undefined, int()) },
	});
	const entered = Promise.withResolvers<Context>(),
		release = Promise.withResolvers<void>();
	const host = createHost({ onError() {} });
	await host.load(
		[
			{
				name: "service",
				facet: defineFacet((h) =>
					h.serve(Service, (_params, self) => {
						self.open(
							async (ctx) => {
								entered.resolve(ctx);
								await awaitWithContext(release.promise, ctx);
								return null;
							},
							() => {},
						);
						return { run: async () => 1 };
					}),
				),
			},
		],
		context,
	);
	const ref = host.hold(Service, { id: 1 }, context);
	const pending = Promise.allSettled([ref.run(context)]);
	try {
		const call = await entered.promise;
		await host.close(context);
		expect(call.abortSignal?.aborted).toBe(true);
		expect(await pending).toMatchObject([{ status: "rejected", reason: { code: "released" } }]);
		expect(ref.state.value.kind).toBe("ended");
	} finally {
		release.resolve();
		ref.release();
		await host.close(context);
		await pending;
	}
});
