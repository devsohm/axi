import { expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT as context, awaitWithContext } from "../src/context/index.ts";
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
} from "../src/index.ts";

const Service = hostKind("shared.service");
const Counter = remote("shared.counter", {
	version: 1,
	params: { id: str() },
	hostAddress: () => Service(),
	variants: {
		ready: {
			state: { data: obj({ total: int() }) },
			methods: { add: method(int(), int()), wait: method(str(), int()) },
		},
	},
});
const State = defineState("shared.state", { version: 1, schema: obj({ total: int() }), initial: () => ({ total: 0 }) });

async function fixture(codec = binaryCodec) {
	const entered: string[] = [];
	const cancelled: string[] = [];
	const answers = new Map<string, ReturnType<typeof Promise.withResolvers<number>>>();
	const server = createHost({ address: Service(), principal: { kind: "server" }, callWindow: 1, onError() {} });
	const client = createHost({ principal: { kind: "client" }, onError() {} });
	await server.load(
		[
			{
				name: "counters",
				facet: defineFacet((host) =>
					host.serve(Counter, (_params, _principal, self) => {
						const state = self.state(State);
						return {
							variant: "ready",
							members: {
								data: self.derive([state], ([value]) => {
									if (value.total < 0) throw new Error("view unavailable");
									return value;
								}),
								async add(amount, ctx) {
									await state.change((draft) => {
										draft.total += amount;
									}, ctx);
									return state.value.total;
								},
								async wait(id, ctx) {
									entered.push(id);
									const answer = Promise.withResolvers<number>();
									answers.set(id, answer);
									try {
										return await awaitWithContext(answer.promise, ctx);
									} catch (error) {
										cancelled.push(id);
										throw error;
									}
								},
							},
						};
					}),
				),
			},
		],
		context,
	);
	await client.load([], context);
	const [near, far] = memoryLinkPair();
	server.accept(near, { principal: { kind: "client" }, codec }, context);
	client.connect(far, { principal: { kind: "server" }, codec }, context);
	return {
		server,
		client,
		entered,
		cancelled,
		answers,
		async close() {
			await client.close(context);
			await server.close(context);
		},
	};
}

test.each([binaryCodec, textCodec])(
	"%s shares a hold while preserving independent reference lifetimes",
	async (codec) => {
		const app = await fixture(codec);
		try {
			const local = await app.server.get(Counter, { id: "one" }, context);
			expect(app.server.activity.value.references).toBe(0);
			const first = await app.client.get(Counter, { id: "one" }, context);
			const second = app.client.hold(Counter, { id: "one" }, context);
			expect(second.state.value.kind).toBe("live");
			expect(first.data.value).toBe(second.data.value);
			await vi.waitFor(() => expect(app.server.activity.value.references).toBe(1));
			const watch = await first.data.watch(context);
			first.release();
			expect((await watch.closed).kind).toBe("ended");
			expect(second.state.value.kind).toBe("live");
			expect(await second.add(2, context)).toBe(2);
			await vi.waitFor(() => expect(second.data.value).toEqual({ total: 2 }));
			second.release();
			await vi.waitFor(() => expect(app.server.activity.value.references).toBe(0));
			expect(local.state.value.kind).toBe("live");
			local.release();
			const next = await app.client.get(Counter, { id: "one" }, context);
			expect(next.state.value.kind).toBe("live");
			next.release();
		} finally {
			await app.close();
		}
	},
);

test("shared member watchers receive a commit in subscription order", async () => {
	const app = await fixture();
	try {
		const first = await app.client.get(Counter, { id: "one" }, context);
		const second = await app.client.get(Counter, { id: "one" }, context);
		const order: string[] = [];
		const secondWatch = await second.data.watch(context);
		const firstWatch = await first.data.watch(context);
		secondWatch.start(async () => {
			order.push("second");
		});
		firstWatch.start(async () => {
			order.push("first");
		});
		await first.add(1, context);
		await vi.waitFor(() => expect(order).toEqual(["second", "first"]));
		await secondWatch.stop();
		await firstWatch.stop();
		first.release();
		second.release();
	} finally {
		await app.close();
	}
});

test("releasing one owner cancels its queued calls before freeing capacity for its sibling", async () => {
	const app = await fixture();
	try {
		const first = await app.client.get(Counter, { id: "one" }, context);
		const second = await app.client.get(Counter, { id: "one" }, context);
		const active = first.wait("A1", context).catch((error) => error);
		await vi.waitFor(() => expect(app.entered).toEqual(["A1"]));
		const queued = first.wait("A2", context).catch((error) => error);
		const sibling = second.wait("B1", context).then(
			(value) => ({ value }),
			(error) => ({ error }),
		);
		first.release();
		expect(await active).toMatchObject({ code: "released" });
		expect(await queued).toMatchObject({ code: "released" });
		await vi.waitFor(() => expect(app.entered).toEqual(["A1", "B1"]));
		expect(app.cancelled).toEqual(["A1"]);
		app.answers.get("B1")!.resolve(7);
		expect(await sibling).toEqual({ value: 7 });
		second.release();
	} finally {
		await app.close();
	}
});

test.each([binaryCodec, textCodec])(
	"%s joiners acquire member history only from values received after joining",
	async (codec) => {
		const app = await fixture(codec);
		try {
			const first = await app.client.get(Counter, { id: "one" }, context);
			const old = await first.data.watch(context);
			await first.add(-1, context);
			const second = await app.client.get(Counter, { id: "one" }, context);
			await expect(second.data.watch(context)).rejects.toThrow("view unavailable");
			expect(old.value).toEqual({ total: 0 });
			await first.add(2, context);
			await first.add(-2, context);
			const own = await second.data.watch(context);
			try {
				expect(own.value).toEqual({ total: 1 });
				await second.add(3, context);
				await vi.waitFor(() => expect(second.data.value).toEqual({ total: 2 }));
			} finally {
				await own.stop();
			}
			await old.stop();
			first.release();
			second.release();
		} finally {
			await app.close();
		}
	},
);
