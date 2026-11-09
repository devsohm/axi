import { expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import {
	constant,
	createHost,
	defineFacet,
	defineState,
	hostKind,
	int,
	memoryLinkPair,
	method,
	obj,
	ObjectsError,
	remote,
	type HostError,
} from "../src/index.ts";

const Address = hostKind("publication.server");
const Counter = remote("publication.counter", {
	version: 1,
	params: {},
	hostAddress: () => Address(),
	variants: { ready: { state: { n: int() }, methods: { set: method(int(), int()) } } },
});
const State = defineState("publication.state", { version: 1, schema: obj({ n: int() }), initial: () => ({ n: 0 }) });
const value = (n: number) =>
	defineFacet((host) =>
		host.serve(Counter, () => ({ variant: "ready", members: { n: constant(n), set: async (next) => next } })),
	);
async function network() {
	const errors: HostError[] = [];
	const server = createHost({
		address: Address(),
		principal: { kind: "server" },
		onError: (error) => errors.push(error),
	});
	const client = createHost({ principal: { kind: "client" }, onError: (error) => errors.push(error) });
	await client.load([], context);
	const [incoming, outgoing] = memoryLinkPair();
	server.accept(incoming, { principal: { kind: "client" } }, context);
	client.connect(outgoing, { principal: { kind: "server" } }, context);
	return {
		server,
		client,
		errors,
		async close() {
			await client.close(context);
			await server.close(context);
		},
	};
}

test.each(["host", "provider"] as const)("a remote read waits until its %s is published", async (publication) => {
	const app = await network();
	let settled = false;
	try {
		if (publication === "provider") await app.server.load([], context);
		const pending = app.client.get(Counter, {}, context, { readyTimeout: 2000 });
		void pending.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		await vi.waitFor(() => expect(app.server.activity.value.references).toBe(1));
		expect(settled).toBe(false);
		const providers = [{ name: "counter", facet: value(7) }];
		if (publication === "host") await app.server.load(providers, context);
		else await app.server.reload(providers, context);
		const ref = await pending;
		expect(ref.n.value).toBe(7);
		expect(await ref.set(9, context)).toBe(9);
		ref.release();
		expect(app.errors).toEqual([]);
	} finally {
		await app.close();
	}
});

test("removing and restoring a provider rebinds the same remote reference", async () => {
	const app = await network();
	try {
		await app.server.load([{ name: "counter", facet: value(1) }], context);
		const ref = await app.client.get(Counter, {}, context);
		expect(ref.n.value).toBe(1);
		await app.server.reload([], context);
		await vi.waitFor(() => expect(ref.state.value).toMatchObject({ kind: "failed", cause: { kind: "waiting" } }));
		ref.retry();
		await app.server.reload([{ name: "counter", facet: value(2) }], context);
		await vi.waitFor(() => expect(ref.state.value.kind).toBe("live"));
		expect(ref.n.value).toBe(2);
		expect(await ref.set(8, context)).toBe(8);
		ref.release();
		await vi.waitFor(() => expect(app.server.activity.value.references).toBe(0));
		expect(app.errors).toEqual([]);
	} finally {
		await app.close();
	}
});

test("a failed replacement retains the live instance until another reload succeeds", async () => {
	const app = await network();
	let failing = true;
	const failed = Promise.withResolvers<void>();
	const replacement = () =>
		defineFacet((host) =>
			host.serve(Counter, () => {
				if (failing) {
					failed.resolve();
					throw new ObjectsError({ code: "unavailable", message: "Resource offline" });
				}
				return { variant: "ready", members: { n: constant(3), set: async (next) => next } };
			}),
		);
	try {
		await app.server.load([{ name: "counter", facet: value(1) }], context);
		const ref = await app.client.get(Counter, {}, context);
		await app.server.reload([{ name: "counter", facet: replacement() }], context);
		await failed.promise;
		expect(ref.state.value.kind).toBe("live");
		expect(ref.n.value).toBe(1);
		expect(await ref.set(8, context)).toBe(8);
		failing = false;
		await app.server.reload([{ name: "counter", facet: replacement() }], context);
		await vi.waitFor(() => expect(ref.n.value).toBe(3));
		expect(ref.state.value.kind).toBe("live");
		expect(await ref.set(10, context)).toBe(10);
		ref.release();
	} finally {
		await app.close();
	}
});

test("remote state reports a derived-value failure and recovers after a later committed update", async () => {
	const app = await network();
	const facet = defineFacet((host) =>
		host.serve(Counter, (_params, _principal, self) => {
			const state = self.state(State);
			return {
				variant: "ready",
				members: {
					n: self.derive([state], ([value]) => {
						if (value.n < 0) throw new ObjectsError({ code: "unavailable", message: "Negative value unavailable" });
						return value.n;
					}),
					set: async (n, ctx) => {
						await state.change((draft) => {
							draft.n = n;
						}, ctx);
						return n;
					},
				},
			};
		}),
	);
	try {
		await app.server.load([{ name: "counter", facet }], context);
		const ref = await app.client.get(Counter, {}, context);
		expect(ref.n.value).toBe(0);
		expect(await ref.set(-1, context)).toBe(-1);
		await vi.waitFor(() => expect(() => ref.n.value).toThrow("Negative value unavailable"));
		expect(await ref.set(-2, context)).toBe(-2);
		await vi.waitFor(() => expect(() => ref.n.value).toThrow("Negative value unavailable"));
		expect(await ref.set(4, context)).toBe(4);
		await vi.waitFor(() => expect(ref.n.value).toBe(4));
		expect(ref.state.value.kind).toBe("live");
		ref.release();
	} finally {
		await app.close();
	}
});
