import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { it } from "vitest";
import {
	createHost,
	defineRegistry,
	type Ctx,
	type Facet,
	hostNamed,
	isChordError,
	local,
	type Link,
	memoryLinkPair,
	method,
	remote,
	type Resource,
	type Self,
} from "../src/index.ts";

it("keeps the reconnect connection when its first restored hold closes the link", async () => {
	const item = remote("reconnect-interruption", {
		version: 1,
		input: Type.Object({ id: Type.Number() }),
		host: hostNamed("parent"),
		variants: { main: {} },
	});
	const parent = createHost({ name: "parent", self: null });
	const child = createHost({ name: "child", self: null });
	parent.serve(item, () => ({ variant: "main" }));
	const initial = memoryLinkPair();
	parent.accept(initial[0], { principal: null, kind: "host", name: "child" });
	child.connect(initial[1], { principal: null });
	const refs = await Promise.all([child.get(item, { id: 1 }), child.get(item, { id: 2 })]);
	try {
		assert.deepEqual(
			refs.map((ref) => ref.status),
			["live", "live"],
		);
		initial[1].close("replace connection");
		const next = memoryLinkPair();
		parent.accept(next[0], { principal: null, kind: "host", name: "child" });
		let holds = 0;
		const interrupted: Link = {
			get closed() {
				return next[1].closed;
			},
			receive: (handler) => next[1].receive(handler),
			onClose: (handler) => next[1].onClose(handler),
			close: (reason) => next[1].close(reason),
			send(frame) {
				if (frame.t === "hold" && ++holds === 1) next[1].close("send failed during reconnect");
				return next[1].send(frame);
			},
		};
		assert.doesNotThrow(() => child.connect(interrupted, { principal: null }));
		assert.equal(holds, 2);
		assert.deepEqual(
			refs.map((ref) => ref.status),
			["loading", "loading"],
		);
	} finally {
		for (const ref of refs) ref.release();
		await child.close();
		await parent.close();
	}
});

it("returns removal results for reference shape and status subscriptions", async () => {
	const host = createHost({ self: null });
	const item = local("reference-observers", { version: 1, input: Type.Object({}), members: {} });
	host.serve(item, () => ({}));
	try {
		const ref = await host.get(item, {});
		const shape = ref.onShape(() => {}),
			status = ref.onStatus(() => {});
		assert.deepEqual([shape(), shape(), status(), status()], [true, false, true, false]);
	} finally {
		await host.close();
	}
});

it("captures the implementation variant during validation", async () => {
	const host = createHost({ self: null });
	const item = remote("variant-reads", {
		version: 1,
		input: Type.Object({}),
		host: hostNamed("host"),
		variants: { main: {} },
	});
	let reads = 0;
	host.serve(item, () => ({
		get variant(): "main" {
			reads++;
			return "main";
		},
	}));
	try {
		const ref = await host.get(item, {});
		assert.equal(ref.status, "live");
		assert.equal(reads, 6);
	} finally {
		await host.close();
	}
});

it("returns the subscription removal result", async () => {
	const host = createHost({ self: null });
	try {
		const remove = host.registry(defineRegistry<number>("items")).subscribe(() => {});
		assert.equal(remove(), true);
		assert.equal(remove(), false);
	} finally {
		await host.close();
	}
});

it("resolves a route immediately after the authorization await", async () => {
	const host = createHost({ self: null, name: "router" });
	const item = remote("route-order", {
		version: 1,
		input: Type.Object({}),
		host: hostNamed("worker"),
		variants: { main: {} },
	});
	const events: string[] = [];
	host.route("worker", {
		principal: () => null,
		authorize() {
			events.push("authorize");
			queueMicrotask(() => {
				events.push("first");
				queueMicrotask(() => events.push("second"));
			});
			return true;
		},
		async resolve() {
			events.push("resolve");
			throw new Error("route stopped");
		},
	});
	try {
		const ref = host.hold(item, {});
		await assert.rejects(ref.ready, /route stopped/);
		assert.deepEqual(events, ["authorize", "first", "resolve", "second"]);
	} finally {
		await host.close();
	}
});

it("preserves the factory receiver and shares resource accessors through the prototype", async () => {
	const item = local("resource-layout", { version: 1, input: Type.Object({}), members: {} });
	const host = createHost({ self: null });
	let factoryIdentity = false;
	let resource: Resource<number> | undefined;
	function factory(this: { factory: unknown } | undefined, _input: object, _principal: unknown, self: Self) {
		factoryIdentity = this?.factory === factory;
		resource = self.resource("handle", { version: 1, open: () => 42 });
		assert.throws(
			() => resource?.value,
			(error) => isChordError(error, "not_ready"),
		);
		return {};
	}
	host.serve(item, factory);
	try {
		const ref = await host.get(item, {});
		assert.equal(factoryIdentity, true);
		assert.ok(resource);
		assert.deepEqual(Object.keys(resource), []);
		assert.equal(Object.hasOwn(resource, "value"), false);
		assert.equal(typeof Object.getOwnPropertyDescriptor(Object.getPrototypeOf(resource), "value")?.get, "function");
		assert.equal(resource.value, 42);
		ref.release();
	} finally {
		await host.close();
	}
});

it("collects retired factory scopes while a host object stays alive", () => {
	const fixture = fileURLToPath(new URL("./fixtures/collect-generations.ts", import.meta.url));
	const result = spawnSync(process.execPath, ["--expose-gc", fixture], { encoding: "utf8", timeout: 10000 });
	assert.equal(result.error, undefined);
	assert.equal(result.status, 0, result.stderr);
});

it("shares a remote binding, stamps its principal, and keeps state live without listeners", async () => {
	const counter = remote("remote-counter", {
		version: 1,
		input: Type.Object({ name: Type.Optional(Type.String({ default: "main" })) }),
		host: hostNamed("provider"),
		variants: {
			main: {
				state: { n: Type.Number() },
				methods: { add: method(Type.Number(), Type.Number()), who: method(undefined, Type.Unknown()) },
			},
		},
	});
	const provider = createHost({
		self: null,
		name: "provider",
		onError(error) {
			throw error;
		},
	});
	let activations = 0;
	provider.serve(counter, (_input, principal, self) => {
		activations++;
		const n = self.state("n", Type.Number(), 0);
		return {
			variant: "main",
			n,
			add(value, ctx) {
				n.change(ctx, (n) => n + value);
				return n.value;
			},
			who: () => principal,
		};
	});
	const [down, up] = memoryLinkPair();
	provider.accept(down, { principal: { user: "reader" } });
	const client = createHost({
		self: null,
		name: "client",
		kind: "client",
		upstream: { link: up, principal: null },
		onError(error) {
			throw error;
		},
	});
	try {
		const a = client.hold(counter, {}),
			b = client.hold(counter, { name: "main" });
		await Promise.all([a.ready, b.ready]);
		const removeShape = a.onShape(() => {}),
			removeStatus = a.onStatus(() => {});
		assert.deepEqual([removeShape(), removeShape(), removeStatus(), removeStatus()], [true, false, true, false]);
		assert.equal(activations, 1);
		assert.deepEqual(await a.who(), { user: "reader" });
		assert.equal(await a.add(3), 3);
		assert.equal(b.n.value, 3);
		a.release();
		assert.equal(await b.add(2), 5);
	} finally {
		await client.close();
		await provider.close();
	}
});

it("takes the principal after reading the other connection options", async () => {
	const identity = remote("connection-identity", {
		version: 1,
		input: Type.Object({}),
		host: hostNamed("provider"),
		variants: { main: { methods: { who: method(undefined, Type.Number()) } } },
	});
	const provider = createHost<number>({ self: 0, name: "provider" });
	provider.serve(identity, (_input, principal) => ({ variant: "main", who: () => principal }));
	const [down, up] = memoryLinkPair();
	let accepted = 0,
		connected = 0;
	provider.accept(down, {
		get principal() {
			return ++accepted;
		},
	});
	const client = createHost<number>({
		self: 0,
		name: "client",
		kind: "client",
		upstream: {
			link: up,
			get principal() {
				return ++connected;
			},
		},
	});
	try {
		const ref = await client.get(identity, {});
		assert.equal(await ref.who(), 2);
		assert.equal(accepted, 2);
		assert.equal(connected, 2);
		ref.release();
	} finally {
		await client.close();
		await provider.close();
	}
});

it("keeps the installed code and state when reload preparation fails", async () => {
	const counter = local("reload-counter", {
		version: 1,
		input: Type.Object({}),
		members: { n: Type.Number(), add: method(Type.Number(), Type.Number()) },
	});
	const host = createHost({ self: null });
	function facet(multiplier: number, fail = false): Facet {
		return {
			name: "counter",
			setup(api) {
				api.serve(counter, (_input, _principal, self) => {
					const n = self.state("n", Type.Number(), 0);
					if (fail) throw new Error("prepare declined");
					return {
						n,
						add(value, ctx) {
							n.change(ctx, (n) => n + value * multiplier);
							return n.value;
						},
					};
				});
			},
		};
	}
	try {
		await host.install(facet(1));
		const ref = host.hold(counter, {});
		assert.equal(await ref.add(2), 2);
		const version = host.codeVersion;
		await assert.rejects(host.reload([facet(4, true)]), /prepare declined/);
		assert.equal(host.codeVersion, version);
		assert.equal(await ref.add(1), 3);
		await host.reload([facet(4)]);
		assert.equal(await ref.add(1), 7);
	} finally {
		await host.close();
	}
});

it("shares the removal reason across objects disposed by one reload", async () => {
	const item = local("removed-item", { version: 1, input: Type.Object({ id: Type.String() }), members: {} });
	const host = createHost({ self: null });
	try {
		await host.install({ name: "items", setup: (api) => api.serve(item, () => ({})) });
		const first = await host.get(item, { id: "a" }),
			second = await host.get(item, { id: "b" });
		const gone = [first, second].map(
			(ref) =>
				new Promise<unknown>((resolve) => {
					ref.onStatus((status, error) => {
						if (status === "gone") resolve(error);
					});
				}),
		);
		await host.reload([], { remove: ["items"] });
		const [a, b] = await Promise.all(gone);
		assert.ok(isChordError(a, "gone"));
		assert.equal(a.message, "gone: type no longer served");
		assert.equal(a, b);
		assert.equal(first.error, second.error);
	} finally {
		await host.close();
	}
});

it("expires root contexts and cancels calls before closing their resources", async () => {
	const work = local("cancel-work", { version: 1, input: Type.Object({}), members: { wait: method() } });
	const host = createHost({ self: null }),
		order: string[] = [];
	let old: Ctx | undefined;
	await host.root((ctx) => {
		old = ctx;
	});
	host.serve(work, (_input, _principal, self) => {
		self.resource("resource", {
			version: 1,
			open: () => null,
			close: () => {
				order.push("close");
			},
		});
		return {
			wait: (ctx) =>
				new Promise<void>((resolve) =>
					ctx.signal.addEventListener("abort", () => {
						order.push("abort");
						resolve();
					}),
				),
		};
	});
	const ref = await host.get(work, {});
	await assert.rejects(ref.wait(old), (error) => isChordError(error) && error.reason === "expired");
	const pending = ref.wait();
	await new Promise((resolve) => setImmediate(resolve));
	await host.close();
	await pending;
	assert.deepEqual(order, ["abort", "close"]);
	assert.equal(ref.status, "gone");
});
