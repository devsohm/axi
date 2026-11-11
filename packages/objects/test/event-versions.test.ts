import { expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import {
	createHost,
	defineFacet,
	event,
	evolve,
	hostKind,
	int,
	local,
	memoryLinkPair,
	obj,
	remote,
	type EventSource,
} from "../src/index.ts";

const flushed = () => new Promise<void>((resolve) => setImmediate(resolve));

test("older event readers share a mapping, isolate failed values and recover after success", async () => {
	const first = local("versioned-feed", { version: 1, params: {}, members: { changed: event(int()) } });
	const current = evolve(first, (e) => e.event("changed", obj({ n: int() })));
	const sources: EventSource<{ n: number }>[] = [],
		errors: unknown[] = [],
		mapped: number[] = [];
	const host = createHost({
		onError: (error) => {
			errors.push(error);
		},
	});
	try {
		await host.load(
			[
				{
					name: "feed",
					facet: defineFacet((h) =>
						h.serve(
							current,
							(_, self) => {
								const changed = self.events<{ n: number }>();
								sources.push(changed);
								return { changed };
							},
							{
								accepts: {
									1: {
										events: {
											changed: ({ n }) => {
												mapped.push(n);
												if (n < 0) throw new Error("Unrepresentable legacy event");
												return n;
											},
										},
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
		const latest = await host.get(current, {}, context);
		const seen: number[][] = [[], []],
			raw: number[] = [];
		await a.changed.on(({ value }) => {
			seen[0]!.push(value);
		}, context);
		await b.changed.on(({ value }) => {
			seen[1]!.push(value);
		}, context);
		await latest.changed.on(({ value }) => {
			raw.push(value.n);
		}, context);
		for (const n of [4, -1, -2, 8, -3]) sources[0]!.emit({ n });
		await flushed();
		expect(mapped).toEqual([4, -1, -2, 8, -3]);
		expect(seen).toEqual([
			[4, 8],
			[4, 8],
		]);
		expect(raw).toEqual([4, -1, -2, 8, -3]);
		expect(errors).toEqual(
			[1, 2].map(() =>
				expect.objectContaining({
					kind: "event_mapping_failed",
					member: "changed",
					version: 1,
					error: expect.objectContaining({ message: "Unrepresentable legacy event" }),
				}),
			),
		);
		a.release();
		b.release();
		sources[0]!.emit({ n: 12 });
		await flushed();
		expect(mapped).toEqual([4, -1, -2, 8, -3]);
		expect(raw).toEqual([4, -1, -2, 8, -3, 12]);
		latest.release();
	} finally {
		await host.close(context);
	}
});

test.each([false, true])("remote older events follow variant mappings, refused=%s", async (refused) => {
	const Address = hostKind("versioned-event-server");
	const first = remote("remote-versioned-feed", {
		version: 1,
		params: {},
		hostAddress: () => Address(),
		variants: { reader: { events: { changed: int() } } },
	});
	const current = evolve(first, (e) => e.event("reader", "changed", obj({ n: int() })));
	const sources: EventSource<{ n: number }>[] = [];
	const host = createHost({
		address: Address(),
		principal: { kind: "server" },
		onError(error) {
			throw error;
		},
	});
	const client = createHost({
		onError(error) {
			throw error;
		},
	});
	try {
		await host.load(
			[
				{
					name: "feed",
					facet: defineFacet((h) =>
						h.serve(
							current,
							(_params, _principal, self) => {
								const changed = self.events<{ n: number }>();
								sources.push(changed);
								return { variant: "reader", members: { changed } };
							},
							{ accepts: { 1: { events: { reader: { changed: refused ? "refuse" : ({ n }) => n } } } } },
						),
					),
				},
			],
			context,
		);
		await client.load([], context);
		const [incoming, outgoing] = memoryLinkPair();
		host.accept(incoming, { principal: { kind: "client" } }, context);
		client.connect(outgoing, { principal: { kind: "server" } }, context);
		const latest = await client.get(current, {}, context),
			older = client.hold(first, {}, context);
		const raw: number[] = [],
			seen: number[] = [];
		await latest.changed.on(({ value }) => {
			raw.push(value.n);
		}, context);
		if (refused)
			await vi.waitFor(() =>
				expect(older.state.value).toMatchObject({
					kind: "failed",
					cause: { kind: "waiting", error: { code: "contract_mismatch" } },
				}),
			);
		else
			await older.changed.on(({ value }) => {
				seen.push(value);
			}, context);
		sources[0]!.emit({ n: 21 });
		await flushed();
		expect(raw).toEqual([21]);
		expect(seen).toEqual(refused ? [] : [21]);
		older.release();
		latest.release();
	} finally {
		await client.close(context);
		await host.close(context);
	}
});
