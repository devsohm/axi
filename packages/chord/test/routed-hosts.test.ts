import { Type } from "typebox";
import { expect, test, vi } from "vitest";
import { createHost, hostFamily, memoryLinkPair, method, remote, type Host } from "../src/index.ts";

const Room = remote("room-document", {
	version: 1,
	input: Type.Object({ room: Type.String() }),
	host: hostFamily("room:", "room"),
	variants: {
		document: {
			state: { body: Type.Object({ text: Type.String() }) },
			methods: {
				append: method(Type.String(), Type.String()),
				identity: method(undefined, Type.String()),
				wait: method(undefined, Type.String()),
			},
		},
	},
});

async function fixture(options: { denyAfterResolve?: boolean } = {}) {
	const hub = createHost({ name: "hub", self: "hub" });
	const workers: Host[] = [],
		clients: Host[] = [];
	const links = new Map<string, ReturnType<typeof memoryLinkPair>[0]>();
	const closed: string[] = [];
	const entered = Promise.withResolvers<AbortSignal>(),
		release = Promise.withResolvers<string>();
	let allowed = true,
		resolutions = 0;
	hub.route("room:", {
		principal: (name) => name,
		authorize: (principal) => allowed && principal !== "blocked",
		async resolve(name) {
			resolutions++;
			const existing = links.get(name);
			if (existing) return existing;
			const [down, up] = memoryLinkPair();
			const worker = createHost({ name, self: "worker", upstream: { link: up, principal: "hub" } });
			workers.push(worker);
			links.set(name, down);
			worker.serve(Room, (_input, principal, self) => {
				const body = self.state("body", Type.Object({ text: Type.String() }), { text: "" });
				self.resource("lease", {
					version: 1,
					open: () => principal,
					close: (owner) => {
						closed.push(String(owner));
					},
				});
				return {
					variant: "document",
					body,
					append(text, context) {
						body.change(context, (draft) => {
							draft.text += text;
						});
						return body.value.text;
					},
					identity: () => String(principal),
					wait(context) {
						entered.resolve(context.signal);
						return release.promise;
					},
				};
			});
			if (options.denyAfterResolve) allowed = false;
			return down;
		},
	});
	return {
		hub,
		closed,
		entered,
		release,
		resolutions: () => resolutions,
		starts: () => workers.length,
		deny() {
			allowed = false;
		},
		client(principal: string, restamp?: (principal: string) => string | undefined) {
			const [down, up] = memoryLinkPair();
			hub.accept(down, { principal, restamp });
			const host = createHost({
				name: "viewer",
				kind: "client",
				self: "viewer",
				upstream: { link: up, principal: "hub" },
			});
			clients.push(host);
			return {
				host,
				disconnect: () => up.close("viewer disconnected"),
				reconnect() {
					const [nextDown, nextUp] = memoryLinkPair();
					hub.accept(nextDown, { principal, restamp });
					host.connect(nextUp, { principal: "hub" });
				},
			};
		},
		async [Symbol.asyncDispose]() {
			release.resolve("released");
			for (const client of clients) await client.close();
			await hub.close();
			for (const worker of workers) await worker.close();
		},
	};
}

test("routed clients share one principal's document while other principals remain isolated", async () => {
	await using f = await fixture();
	const alice = f.client("alice"),
		another = f.client("alice"),
		bob = f.client("bob");
	const a = await alice.host.get(Room, { room: "draft" }),
		a2 = await another.host.get(Room, { room: "draft" }),
		b = await bob.host.get(Room, { room: "draft" });
	const values: string[] = [];
	const stop = a2.body.subscribe((value) => values.push(value.text));
	expect(await a.identity()).toBe("alice");
	expect(await b.identity()).toBe("bob");
	expect(await a.append("hello")).toBe("hello");
	await vi.waitFor(() => expect(values).toEqual(["", "hello"]));
	expect(await a2.append(" world")).toBe("hello world");
	expect(await b.append("private")).toBe("private");
	expect(f.starts()).toBe(1);
	expect(f.resolutions()).toBe(3);
	stop();
	a.release();
	a2.release();
	b.release();
});

test("route authorization is rechecked after resolving the host", async () => {
	await using f = await fixture({ denyAfterResolve: true });
	const ref = f.client("alice").host.hold(Room, { room: "draft" });
	await expect(ref.ready).rejects.toMatchObject({ code: "forbidden" });
	expect(f.starts()).toBe(1);
	expect(f.closed).toEqual([]);
	ref.release();
});

test("authorization rejects a routed hold before a worker is created", async () => {
	await using f = await fixture();
	const client = f.client("blocked");
	const denied = client.host.hold(Room, { room: "draft" });
	await expect(denied.ready).rejects.toMatchObject({ code: "forbidden" });
	expect(f.resolutions()).toBe(0);
	denied.release();
	const allowed = await f.client("alice").host.get(Room, { room: "draft" });
	expect(await allowed.append("allowed")).toBe("allowed");
	allowed.release();
});

test("cancellation traverses a relay and later calls still reach the worker", async () => {
	await using f = await fixture();
	const client = f.client("alice"),
		ref = await client.host.get(Room, { room: "draft" });
	const controller = new AbortController();
	const run = client.host.root((context) => ref.wait(context), { signal: controller.signal });
	const signal = await f.entered.promise;
	controller.abort("stop routed work");
	await expect(run).rejects.toMatchObject({ code: "aborted" });
	await vi.waitFor(() => expect(signal.aborted).toBe(true));
	f.release.resolve("late");
	expect(await ref.append("after cancellation")).toBe("after cancellation");
	ref.release();
});

test("disconnecting one viewer releases its worker object without affecting another viewer", async () => {
	await using f = await fixture();
	const alice = f.client("alice"),
		bob = f.client("bob");
	const a = await alice.host.get(Room, { room: "draft" }),
		b = await bob.host.get(Room, { room: "draft" });
	expect(await a.append("a")).toBe("a");
	expect(await b.append("b")).toBe("b");
	alice.disconnect();
	await vi.waitFor(() => expect(f.closed).toEqual(["alice"]));
	expect(await b.append("2")).toBe("b2");
	b.release();
	a.release();
});

test("reconnected viewers receive a reset rather than deltas from the disposed document", async () => {
	await using f = await fixture();
	const client = f.client("alice"),
		ref = await client.host.get(Room, { room: "draft" });
	const deliveries: string[] = [];
	const stop = ref.body.events((event) => deliveries.push(event.type));
	expect(await ref.append("old")).toBe("old");
	client.disconnect();
	await vi.waitFor(() => expect(f.closed).toEqual(["alice"]));
	expect(ref.status).toBe("loading");
	client.reconnect();
	await ref.ready;
	expect(await ref.append("new")).toBe("new");
	await vi.waitFor(() => expect(ref.body.value).toEqual({ text: "new" }));
	expect(deliveries[0]).toBe("snap");
	expect(deliveries).toContain("reset");
	stop();
	ref.release();
});

test("principal invalidation closes old relays and re-stamps new holds", async () => {
	await using f = await fixture();
	const client = f.client("alice", () => "alice-v2");
	const first = await client.host.get(Room, { room: "draft" });
	expect(await first.identity()).toBe("alice");
	await f.hub.invalidatePrincipal((principal) => principal === "alice");
	await vi.waitFor(() => expect(first.status).toBe("gone"));
	await vi.waitFor(() => expect(f.closed).toEqual(["alice"]));
	const next = await client.host.get(Room, { room: "draft" });
	expect(await next.identity()).toBe("alice-v2");
	expect(await next.append("fresh identity")).toBe("fresh identity");
	first.release();
	next.release();
});
