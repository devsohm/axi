import { expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import {
	constant,
	createHost,
	defineFacet,
	hostKind,
	int,
	local,
	memoryLinkPair,
	remote,
	str,
} from "../src/next/index.ts";

it("keeps an explicitly anonymous root anonymous and limits it to local objects", async () => {
	const Value = local("root.local", { version: 1, params: {}, members: { value: int() } });
	const Server = hostKind("server");
	const Shared = remote("root.shared", {
		version: 1,
		params: {},
		hostAddress: () => Server(),
		variants: { value: { state: { value: int() }, methods: {} } },
	});
	const host = createHost({ address: Server(), principal: { kind: "service" }, onError() {} });
	await host.load(
		[
			{
				name: "core",
				facet: defineFacet((h) => {
					h.serve(Value, () => ({ value: constant(7) }));
					h.serve(Shared, () => ({ variant: "value", members: { value: constant(9) } }));
				}),
			},
		],
		context,
	);
	try {
		expect(await host.root(async (ctx) => ctx.principal, context)).toEqual({ kind: "service" });
		await host.root(
			async (ctx) => {
				expect(ctx.principal).toBeUndefined();
				expect((await ctx.get(Value, {})).value.value).toBe(7);
				await expect(ctx.get(Shared, {})).rejects.toMatchObject({ code: "forbidden" });
			},
			context,
			{ principal: undefined },
		);
	} finally {
		await host.close(context);
	}
});

it("retries a failed route only on demand and can suspend new holders until retry", async () => {
	const Worker = hostKind("runner", { id: str() });
	const address = Worker({ id: "one" });
	const Value = remote("route.value", {
		version: 1,
		params: {},
		hostAddress: () => address,
		variants: { value: { state: { value: int() }, methods: {} } },
	});
	const host = createHost({ principal: { kind: "service" }, onError() {} });
	const worker = createHost({ principal: { kind: "service" }, address, onError() {} });
	await worker.load(
		[
			{
				name: "core",
				facet: defineFacet((h) => h.serve(Value, () => ({ variant: "value", members: { value: constant(12) } }))),
			},
		],
		context,
	);
	let attempts = 0;
	const controls = host.route(
		Worker,
		{
			authorize: () => true,
			async resolve() {
				if (++attempts === 1) throw new Error("worker not started");
				const [link, peer] = memoryLinkPair();
				worker.accept(peer, { principal: { kind: "service" }, trusted: true }, context);
				return { link, principal: { kind: "service" }, trusted: true };
			},
		},
		context,
	);
	await host.load([], context);
	const first = host.hold(Value, {}, context);
	let second: ReturnType<typeof host.hold<typeof Value>> | undefined;
	try {
		await vi.waitFor(() => expect(first.state.value).toMatchObject({ kind: "failed", cause: { kind: "waiting" } }));
		controls.suspend(address);
		const following = host.hold(Value, {}, context);
		second = following;
		await vi.waitFor(() =>
			expect(following.state.value).toMatchObject({
				kind: "failed",
				cause: { error: { message: "runner|one: suspended" } },
			}),
		);
		expect(attempts).toBe(1);
		controls.retry(address);
		await vi.waitFor(() => expect(first.state.value).toEqual({ kind: "live" }));
		expect((await host.get(Value, {}, context)).value.value).toBe(12);
		expect(attempts).toBe(2);
	} finally {
		first.release();
		second?.release();
		await host.close(context);
		await worker.close(context);
	}
});
