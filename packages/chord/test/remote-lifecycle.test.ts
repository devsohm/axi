import { Type } from "typebox";
import { expect, test, vi } from "vitest";
import { createHost, hostNamed, memoryLinkPair, method, remote } from "../src/index.ts";

const Service = remote("delivery-service", {
	version: 1,
	input: Type.Object({}),
	host: hostNamed("service"),
	variants: {
		ready: {
			state: { text: Type.String() },
			methods: { echo: method(Type.String(), Type.String()), pause: method(undefined, Type.String()) },
		},
	},
});

async function fixture(options: { maxCalls?: number; pingInterval?: number; pingTimeout?: number } = {}) {
	const entered = Promise.withResolvers<AbortSignal>(),
		release = Promise.withResolvers<string>();
	const server = createHost({ name: "service", self: "host" });
	let closes = 0;
	server.serve(Service, (_input, principal, self) => {
		const text = self.state("text", Type.String(), "initial");
		self.resource("connection", {
			version: 1,
			open: () => "open",
			close: () => {
				closes++;
			},
		});
		return {
			variant: "ready",
			text,
			echo(value, context) {
				text.change(context, () => value);
				return `${principal}/${context.principal}:${value}`;
			},
			pause(context) {
				entered.resolve(context.signal);
				return release.promise;
			},
		};
	});
	const [down, up] = memoryLinkPair();
	server.accept(down, { principal: "alice", ...options });
	const client = createHost({
		name: "caller",
		kind: "client",
		self: "local",
		upstream: { link: up, principal: "service", ...options },
	});
	const reference = await client.get(Service, {});
	return {
		client,
		server,
		reference,
		entered,
		release,
		up,
		closes: () => closes,
		async [Symbol.asyncDispose]() {
			release.resolve("released");
			reference.release();
			await client.close();
			await server.close();
		},
	};
}

test("remote methods validate inputs, use the authenticated principal and publish observable state", async () => {
	await using c = await fixture();
	const values: string[] = [];
	const stop = c.reference.text.subscribe((value) => values.push(value));
	expect(await c.reference.echo("updated")).toBe("alice/host:updated");
	await vi.waitFor(() => expect(values).toEqual(["initial", "updated"]));
	await expect(Reflect.apply(c.reference.echo, c.reference, [42])).rejects.toMatchObject({ code: "invalid" });
	expect(await c.reference.echo("still works")).toBe("alice/host:still works");
	stop();
});

test("root cancellation reaches the remote method and leaves the connection usable", async () => {
	await using c = await fixture();
	const controller = new AbortController();
	const pending = c.client.root((context) => c.reference.pause(context), { signal: controller.signal });
	const remoteSignal = await c.entered.promise;
	controller.abort("caller left");
	await expect(pending).rejects.toMatchObject({ code: "aborted" });
	await vi.waitFor(() => expect(remoteSignal.aborted).toBe(true));
	c.release.resolve("late result");
	expect(await c.reference.echo("after cancel")).toBe("alice/host:after cancel");
});

test("call admission rejects excess work and releases capacity when admitted work finishes", async () => {
	await using c = await fixture({ maxCalls: 1 });
	const pending = c.reference.pause();
	await c.entered.promise;
	await expect(c.reference.echo("excess")).rejects.toMatchObject({ code: "unavailable", reason: "too_many_calls" });
	c.release.resolve("finished");
	expect(await pending).toBe("finished");
	expect(await c.reference.echo("next")).toBe("alice/host:next");
});

test("heartbeat loss closes a severed link and releases its remote resources", async () => {
	await using c = await fixture({ pingInterval: 5, pingTimeout: 25 });
	expect(await c.reference.echo("before disconnect")).toBe("alice/host:before disconnect");
	c.up.sever();
	await vi.waitFor(() => expect(c.closes()).toBe(1));
	expect(c.up.closed).toBe(true);
	expect(c.reference.status).toBe("loading");
});
