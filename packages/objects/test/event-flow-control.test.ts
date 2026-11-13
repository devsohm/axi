import { expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import {
	binaryCodec,
	createHost,
	defineFacet,
	defineState,
	hostKind,
	int,
	memoryLinkPair,
	method,
	obj,
	remote,
	str,
	textCodec,
	type EventSource,
} from "../src/index.ts";

for (const codec of [binaryCodec, textCodec]) {
	test(`${codec.name} drains pending state and a new binding without starving either`, async () => {
		const Address = hostKind("state-credit.server");
		const Counter = remote("state-credit.counter", {
			version: 1,
			params: { id: str() },
			hostAddress: () => Address(),
			variants: { reader: { state: { count: int() } } },
		});
		const State = defineState("state-credit.value", {
			version: 1,
			schema: obj({ count: int() }),
			initial: () => ({ count: 0 }),
		});
		const setters = new Map<string, (count: number) => Promise<void>>(),
			acknowledgements: (() => void)[] = [],
			reports: unknown[] = [];
		const server = createHost({
			address: Address(),
			principal: { kind: "server" },
			onError: (error) => reports.push(error),
		});
		const client = createHost({ onError: (error) => reports.push(error) });
		try {
			await server.load(
				[
					{
						name: "counters",
						facet: defineFacet((host) =>
							host.serve(Counter, ({ id }, _principal, self) => {
								const state = self.state(State);
								setters.set(id, async (count) => {
									await state.change((draft) => {
										draft.count = count;
									}, context);
								});
								return { variant: "reader", members: { count: self.derive([state], ([value]) => value.count) } };
							}),
						),
					},
				],
				context,
			);
			await client.load([], context);
			const [incoming, outgoing] = memoryLinkPair(),
				send = outgoing.send.bind(outgoing);
			outgoing.send = (frame) => {
				const message = codec.decode(frame);
				if (message.kind === "ack") acknowledgements.push(() => send(frame));
				else send(frame);
			};
			server.accept(incoming, { principal: { kind: "viewer" }, codec }, context);
			client.connect(outgoing, { principal: { kind: "server" }, codec }, context);
			const left = await client.get(Counter, { id: "left" }, context);
			await setters.get("left")!(1);
			await vi.waitFor(() => {
				expect(left.count.value).toBe(1);
				expect(acknowledgements).toHaveLength(2);
			});
			await setters.get("left")!(2);
			const right = client.hold(Counter, { id: "right" }, context);
			await vi.waitFor(() => expect(setters.has("right")).toBe(true));
			expect(right.state.value.kind).toBe("loading");
			expect(left.count.value).toBe(1);
			acknowledgements.shift()!();
			await vi.waitFor(() => expect(left.count.value).toBe(2));
			expect(right.state.value.kind).toBe("loading");
			acknowledgements.shift()!();
			await vi.waitFor(() => expect(right.state.value.kind).toBe("live"));
			expect(right.count.value).toBe(0);
			left.release();
			right.release();
			for (const acknowledge of acknowledgements.splice(0)) acknowledge();
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(reports).toEqual([]);
		} finally {
			await client.close(context);
			await server.close(context);
		}
	});

	test.each([false, true])(
		`${codec.name} event credit returns only after the consumer acknowledges, relayed=%s`,
		async (relayed) => {
			const Address = hostKind("event-credit.server");
			const Feed = remote("event-credit.feed", {
				version: 1,
				params: {},
				hostAddress: () => Address(),
				variants: { reader: { events: { next: str() }, methods: { ping: method(undefined, int()) } } },
			});
			const reports: unknown[] = [],
				sources: EventSource<string>[] = [],
				acknowledgements: (() => void)[] = [];
			const options = { onError: (error: unknown) => reports.push(error) };
			const server = createHost({ ...options, address: Address(), principal: { kind: "server" }, eventWindow: 1 });
			const gateway = relayed ? createHost({ ...options, principal: { kind: "gateway" } }) : server;
			const client = createHost(options);
			try {
				await server.load(
					[
						{
							name: "feed",
							facet: defineFacet((host) =>
								host.serve(Feed, (_params, _principal, self) => {
									const next = self.events<string>();
									sources.push(next);
									return { variant: "reader", members: { next, ping: async () => 17 } };
								}),
							),
						},
					],
					context,
				);
				if (relayed) {
					gateway.route(
						Address,
						{
							authorize: () => true,
							resolve: async () => {
								const [incoming, outgoing] = memoryLinkPair();
								server.connect(incoming, { principal: { kind: "gateway" }, trusted: true, codec }, context);
								return { link: outgoing, principal: { kind: "server" }, trusted: true, codec };
							},
						},
						context,
					);
					await gateway.load([], context);
				}
				await client.load([], context);
				const [incoming, outgoing] = memoryLinkPair(),
					send = outgoing.send.bind(outgoing);
				outgoing.send = (frame) => {
					const message = codec.decode(frame);
					if (message.kind === "ack" && message.events !== undefined) acknowledgements.push(() => send(frame));
					else send(frame);
				};
				gateway.accept(incoming, { principal: { kind: "viewer" }, codec }, context);
				client.connect(outgoing, { principal: { kind: "gateway" }, codec }, context);
				const feed = await client.get(Feed, {}, context),
					seen: string[] = [];
				await feed.next.on(({ value }) => seen.push(value), context);
				sources[0]!.emit("accepted");
				await vi.waitFor(() => {
					expect(seen).toEqual(["accepted"]);
					expect(acknowledgements).toHaveLength(1);
				});
				sources[0]!.emit("dropped");
				expect(await feed.ping(context)).toBe(17);
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect(seen).toEqual(["accepted"]);
				expect(acknowledgements).toHaveLength(1);
				acknowledgements.shift()!();
				await new Promise<void>((resolve) => setImmediate(resolve));
				sources[0]!.emit("after credit");
				await vi.waitFor(() => expect(seen).toEqual(["accepted", "after credit"]));
				feed.release();
				acknowledgements.shift()!();
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect(reports).toEqual([]);
			} finally {
				await client.close(context);
				if (relayed) await gateway.close(context);
				await server.close(context);
			}
		},
	);
}
