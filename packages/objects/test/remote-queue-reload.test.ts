import { expect, test } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import {
	binaryCodec,
	createHost,
	defineFacet,
	hostKind,
	int,
	local,
	memoryLinkPair,
	method,
	remote,
} from "../src/index.ts";

test("a call queued before reload keeps its original ancestry flag when its send window opens", async () => {
	const Address = hostKind("queued-ancestry.server");
	const Work = remote("queued-ancestry.work", {
		version: 1,
		params: {},
		hostAddress: () => Address(),
		variants: { ready: { methods: { run: method(int(), int()) } } },
	});
	const Caller = local("queued-ancestry.caller", {
		version: 1,
		params: {},
		members: { run: method(undefined, int()) },
	});
	const entered = Promise.withResolvers<void>(),
		finish = Promise.withResolvers<void>(),
		queued = Promise.withResolvers<void>();
	const sent: boolean[] = [],
		reports: unknown[] = [];
	const server = createHost({
		address: Address(),
		principal: { kind: "server" },
		callWindow: 1,
		onError: (error) => reports.push(error),
	});
	const client = createHost({ principal: { kind: "client" }, onError: (error) => reports.push(error) });
	const facet = () =>
		defineFacet((h) =>
			h.serve(Caller, (_, self) => {
				const dependency = self.get(Work, {});
				return {
					run: async (ctx) => {
						const pending = dependency.run(1, ctx);
						queued.resolve();
						return pending;
					},
				};
			}),
		);
	let first: Promise<unknown> | undefined, running: Promise<unknown> | undefined;
	try {
		await server.load(
			[
				{
					name: "worker",
					facet: defineFacet((h) =>
						h.serve(Work, () => ({
							variant: "ready",
							members: {
								run: async (value) => {
									if (value === 0) {
										entered.resolve();
										await finish.promise;
									}
									return value;
								},
							},
						})),
					),
				},
			],
			context,
		);
		const [a, b] = memoryLinkPair(),
			send = b.send.bind(b);
		b.send = (packet) => {
			const message = binaryCodec.decode(packet);
			if (message.kind === "call") sent.push(message.old === true);
			send(packet);
		};
		server.accept(a, { principal: { kind: "client" } }, context);
		client.connect(b, { principal: { kind: "server" } }, context);
		await client.load([{ name: "caller", facet: facet() }], context);
		const worker = await client.get(Work, {}, context),
			caller = await client.get(Caller, {}, context);
		first = worker.run(0, context);
		void first.catch(() => {});
		await entered.promise;
		running = caller.run(context);
		void running.catch(() => {});
		await queued.promise;
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(sent).toEqual([false]);
		await client.reload([{ name: "caller", facet: facet() }], context);
		finish.resolve();
		expect(await first).toBe(0);
		expect(await running).toBe(1);
		expect(sent).toEqual([false, false]);
		worker.release();
		caller.release();
		expect(reports).toEqual([]);
	} finally {
		finish.resolve();
		await Promise.allSettled([first, running]);
		await client.close(context);
		await server.close(context);
	}
});
