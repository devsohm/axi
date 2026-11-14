import { expect, test } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import {
	constant,
	createHost,
	defineFacet,
	defineState,
	hostKind,
	int,
	keyed,
	local,
	memoryLinkPair,
	method,
	obj,
	remote,
	type EventSource,
} from "../src/index.ts";

test.each([false, true].flatMap((linked) => ["release", "close"].map((end) => ({ linked, end }))))(
	"reference members end together on $end (linked=$linked)",
	async ({ linked, end }) => {
		const Address = hostKind("reference-lifetime.server");
		const Counter = remote("reference-lifetime.counter", {
			version: 1,
			params: {},
			hostAddress: () => Address(),
			variants: {
				active: {
					state: { n: int() },
					events: { changed: int() },
					methods: { touch: method(undefined, int()) },
				},
			},
		});
		const server = createHost({ address: Address(), principal: { kind: "server" }, onError() {} });
		const client = linked ? createHost({ onError() {} }) : server;
		let source: EventSource<number> | undefined;
		try {
			await server.load(
				[
					{
						name: "counter",
						facet: defineFacet((host) =>
							host.serve(Counter, (_params, _principal, self) => {
								const changed = self.events<number>();
								source = changed;
								return {
									variant: "active",
									members: {
										n: constant(1),
										changed,
										touch: async (_ctx) => {
											changed.emit(1);
											return 1;
										},
									},
								};
							}),
						),
					},
				],
				context,
			);
			if (linked) {
				await client.load([], context);
				const [incoming, outgoing] = memoryLinkPair();
				server.accept(incoming, { principal: { kind: "client" } }, context);
				client.connect(outgoing, { principal: { kind: "server" } }, context);
			}
			const ref = await client.get(Counter, {}, context);
			expect(ref.variant).toBe("active");
			expect(await ref.touch(context)).toBe(1);
			const values = await ref.n.watch(context);
			const seen: number[] = [];
			const subscription = await ref.changed.on(({ value }) => {
				seen.push(value);
			}, context);
			if (end === "release") ref.release();
			else await client.close(context);
			await values.closed;
			expect(ref.state.value).toMatchObject({ kind: "ended", error: { code: "released" } });
			expect(() => ref.variant).toThrow();
			expect(() => ref.n.value).toThrow();
			await expect(ref.n.watch(context)).rejects.toMatchObject({ code: "released" });
			await expect(ref.changed.on(() => {}, context)).rejects.toMatchObject({ code: "released" });
			await expect(ref.touch(context)).rejects.toMatchObject({ code: "released" });
			const ended = await ref.state.watch(context);
			await ended.closed;
			expect(() => source?.emit(2)).toThrow();
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(seen).toEqual([]);
			subscription.stop();
			ref.release();
		} finally {
			await client.close(context);
			if (linked) await server.close(context);
		}
	},
);

test.each(["release", "close"])("local keyed references reject reads and new watches after %s", async (end) => {
	const schema = obj({ n: int() });
	const Rows = defineState("reference-lifetime.rows", { version: 1, schema, keyed: true, initial: () => ({ n: 0 }) });
	const Board = local("reference-lifetime.board", {
		version: 1,
		params: {},
		members: {
			rows: keyed(schema),
			write: method(undefined, int()),
		},
	});
	const host = createHost({ onError() {} });
	try {
		await host.load(
			[
				{
					name: "board",
					facet: defineFacet((facet) =>
						facet.serve(Board, (_params, self) => {
							const rows = self.state(Rows);
							return {
								rows,
								write: async (ctx) => {
									await rows.change(
										"one",
										(draft) => {
											draft.n++;
										},
										ctx,
									);
									return 1;
								},
							};
						}),
					),
				},
			],
			context,
		);
		const ref = await host.get(Board, {}, context);
		expect(() => ref.rows.at("one")).toThrow("valid only in the factory");
		expect(await ref.write(context)).toBe(1);
		const watch = await ref.rows.watch("one", context);
		if (!watch) throw new Error("The committed key is missing");
		expect(watch.value).toEqual({ n: 1 });
		if (end === "release") ref.release();
		else await host.close(context);
		await watch.closed;
		await expect(ref.rows.get("one", context)).rejects.toMatchObject({ code: "released" });
		await expect(ref.rows.watch("one", context)).rejects.toMatchObject({ code: "released" });
		ref.release();
	} finally {
		await host.close(context);
	}
});
