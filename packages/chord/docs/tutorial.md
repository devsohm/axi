# Build and reload observable objects

Run the TypeScript blocks below in order in one ES module. The imports and counter facet are shared; each block closes its hosts. The examples use no database or network service.

## State, methods and references

A contract identifies an object type and its members. Input selects an object; method arguments select an operation. A synchronous factory declares state and returns an implementation.

```ts
import assert from "node:assert/strict";
import { Type } from "typebox";
import {
	type Ctx, type Facet, createHost, defineRegistry, hostNamed,
	isChordError, local, memoryLinkPair, method, remote,
} from "@axi/chord";

const Counter = local("tutorial.counter", {
	version: 1,
	input: Type.Object({ label: Type.String() }),
	members: {
		count: Type.Number(), doubled: Type.Number(),
		caption: method(undefined, Type.String()), add: method(Type.Number()),
	},
});
function counterFacet(title: string): Facet {
	return {
		name: "counter",
		setup(api) {
			api.serve(Counter, ({ label }, _principal, self) => {
				const count = self.state("count", Type.Number(), 0);
				const doubled = self.derive([count], value => value * 2);
				return {
					count, doubled, caption: () => `${title}: ${label}`,
					add(amount, ctx) { count.change(ctx, value => value + amount); },
				};
			});
		},
	};
}
{
	const host = createHost({ self: "application", dev: true });
	try {
		await host.load([counterFacet("Count")]);
		const counter = await host.get(Counter, { label: "jobs" });
		const seen: number[] = [];
		const stop = counter.doubled.subscribe(value => seen.push(value));
		await host.root(ctx => counter.add(3, ctx));
		assert.equal(counter.count.value, 3);
		assert.deepEqual(seen, [0, 6]);
		stop();
		counter.release();
	} finally { await host.close(); }
}
```

`get()` waits for activation and requested state. `hold()` returns immediately; reads before readiness fail. Subscriptions receive a current value and subsequent changes. Published values are immutable by contract. Change a temporary draft inside synchronous `change()`, or transfer ownership of a replacement through `replace()`.

Pass `ctx` to nested calls so cancellation and code versions follow the call tree. `ctx.get()` acquires a reference that ends with that call. `host.get()` acquires a separately owned reference that the caller releases explicitly. Releasing the final reference eventually disposes the object, subject to its linger delay.

## Principal-specific remote views

A remote contract declares JSON state and methods, its destination and its variants. The accepting host supplies the authenticated principal. Views can offer different members while forwarding one shared host-local store.

```ts
{
	const Panel = remote("tutorial.panel", {
		version: 1, input: Type.Object({ label: Type.String() }), host: hostNamed("primary"),
		variants: {
			viewer: { state: { count: Type.Number() } },
			editor: { state: { count: Type.Number() }, methods: { add: method(Type.Number()) } },
		},
	});
	const server = createHost({ self: "server", name: "primary" });
	const [incoming, outgoing] = memoryLinkPair();
	server.accept(incoming, { kind: "client", principal: "editor" });
	const client = createHost({
		self: "client", kind: "client", upstream: { link: outgoing, principal: "server" },
	});
	try {
		await server.load([counterFacet("Remote")]);
		server.serve(Panel, (input, principal, self) => {
			const counter = self.get(Counter, input);
			if (principal === "viewer") return { variant: "viewer", count: counter.count };
			return { variant: "editor", count: counter.count, add: (amount, ctx) => counter.add(amount, ctx) };
		});
		const panel = await client.get(Panel, { label: "shared" });
		assert.equal(panel.count.value, 0);
		assert.ok(panel.variant === "editor");
		const updated = Promise.withResolvers<void>();
		const stop = panel.count.subscribe(value => { if (value === 2) updated.resolve(); });
		await panel.add(2);
		await updated.promise;
		assert.equal(panel.count.value, 2);
		stop();
		panel.release();
		await assert.rejects(panel.add(1), error => isChordError(error, "released"));
	} finally {
		await client.close();
		await server.close();
	}
}
```

Memory links run the remote protocol without network setup. IPC and WebSocket links use the same contracts. Authenticate real connections before accepting them. A variant controls available members; application code still checks grants and operation-specific rules. Revoke changed identities through `invalidatePrincipal()`.

## Resources, listeners, tasks and registrations

Host-lifetime objects activate when their facet loads. They remain until the host closes or the facet is removed. Only these objects can register contributions. Referenced objects activate on demand instead.

```ts
{
	const Commands = defineRegistry<(ctx: Ctx) => Promise<void>>("tutorial.commands");
	const Service = local("tutorial.service", { version: 1, input: Type.Object({}) });
	const closed = Promise.withResolvers<void>();
	const seeded = Promise.withResolvers<void>();
	const stopped = Promise.withResolvers<void>();
	const entries: number[] = [];
	const host = createHost({ self: "application" });
	try {
		await host.load([counterFacet("Background"), {
			name: "commands",
			setup(api) {
				api.serve(Service, (_input, _principal, self) => {
					const counter = self.get(Counter, { label: "background" });
					const log = self.resource("log", {
						version: 1, open: () => entries, close: () => closed.resolve(),
					});
					self.on("count", counter.count, value => { log.value.push(value); });
					self.register(Commands, { increment: ctx => counter.add(1, ctx) });
					self.task(async ctx => {
						await counter.add(1, ctx);
						seeded.resolve();
						await new Promise<void>(resolve => {
							if (ctx.signal.aborted) resolve();
							else ctx.signal.addEventListener("abort", () => resolve(), { once: true });
						});
						stopped.resolve();
					});
					return {};
				}, { lifetime: "host" });
			},
		}]);
		await seeded.promise;
		await host.root(async ctx => {
			const command = host.registry(Commands).get("increment", ctx);
			assert.ok(command);
			await command(ctx);
		});
		assert.deepEqual(entries, [0, 1, 2]);
	} finally { await host.close(); }
	await Promise.all([closed.promise, stopped.promise]);
}
```

Factories declare dependencies synchronously. Resources open before methods use them; do not read them inside a factory. Cleanup stops tasks and listeners, joins invocations, closes resources in reverse opening order, then releases dependencies.

Tasks obey cancellation. Their method calls start short roots. State listeners may receive a current value again when reload replaces their source; set the observed state rather than counting notifications. For native local values, declare `opaque()` members and return `self.expose(resource)`.

## Replace running code

A facet name identifies the code being replaced. Named cells retain their values. A compatible update lets admitted roots finish on their original code version; new roots see the replacement.

```ts
{
	const host = createHost({ self: "application" });
	try {
		await host.load([counterFacet("First")]);
		const counter = await host.get(Counter, { label: "reload" });
		await counter.add(4);
		const entered = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		const previous = host.root(async ctx => {
			const first = await counter.caption(ctx);
			entered.resolve();
			await resume.promise;
			return [first, await counter.caption(ctx)];
		});
		await entered.promise;
		try {
			const result = await host.reload([counterFacet("Second")]);
			assert.deepEqual(result.gated, []);
			assert.equal(await counter.caption(), "Second: reload");
		} finally { resume.resolve(); }
		assert.deepEqual(await previous, ["First: reload", "First: reload"]);
		assert.equal(counter.count.value, 4);
		counter.release();
	} finally { await host.close(); }
}
```

Use separate versions for separate boundaries:

| Version | Change it when | Mechanism |
| --- | --- | --- |
| Contract | Members or their meaning break a caller's contract | A higher contract version and `accepts` adapters for supported older callers |
| Cell | The state schema or meaning changes | A higher `state()` version and, when required, `migrate(old, from)` |
| Resource | The resource must reopen | A different resource version, dependency list or exclusivity |

State migrations and exclusive resource replacement gate the affected object. Admitted roots may finish; other old-code calls receive retryable `upgrade_conflict`. Failed preparation leaves installed code intact. The [guide](guide.md#reload-transactions) covers deadlines, rollback and cluster coordination.

Test factories with real hosts and literal state assertions. A fake facet can replace a dependency while preserving its contract. Check stable error codes, await observable transitions, unsubscribe, release references and close hosts in cleanup.

These cells last only while their objects exist. Disposal and process restart lose them unless the application explicitly loads and saves data. Reload is not durable recovery.
