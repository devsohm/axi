import { expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import { constant, createHost, defineFacet, hostKind, int, memoryLinkPair, method, remote } from "../src/index.ts";

it.each([false, true])(
	"revokes a waiting caller while another recovers when its provider arrives, relayed=%s",
	async (relayed) => {
		const Service = hostKind("revocation.waiting-service");
		const Value = remote("revocation.waiting-value", {
			version: 1,
			params: {},
			hostAddress: () => Service(),
			variants: { available: { state: { value: int() }, methods: { ping: method(undefined, int()) } } },
		});
		const options = { revokedBy: (principal: { kind: string }) => [principal.kind], onError() {} };
		const server = createHost({ ...options, address: Service(), principal: { kind: "server" } });
		const gateway = relayed ? createHost({ ...options, principal: { kind: "gateway" } }) : server;
		let available = false;
		const route = relayed
			? gateway.route(
					Service,
					{
						authorize: () => true,
						async resolve() {
							if (!available) throw new Error("Provider not started");
							const [incoming, outgoing] = memoryLinkPair();
							server.connect(incoming, { principal: { kind: "gateway" }, trusted: true }, context);
							return { link: outgoing, principal: { kind: "server" }, trusted: true };
						},
					},
					context,
				)
			: undefined;
		await server.load([], context);
		if (relayed) await gateway.load([], context);
		const principals = [{ kind: "revoked" }, { kind: "retained" }];
		const clients = principals.map((principal) => createHost({ principal, onError() {} }));
		for (const [index, client] of clients.entries()) {
			await client.load([], context);
			const [incoming, outgoing] = memoryLinkPair();
			gateway.accept(incoming, { principal: principals[index]! }, context);
			client.connect(outgoing, { principal: { kind: relayed ? "gateway" : "server" } }, context);
		}
		const revoked = clients[0]!.hold(Value, {}, context),
			retained = clients[1]!.hold(Value, {}, context);
		try {
			await vi.waitFor(() => {
				expect(revoked.state.value.kind).toBe("failed");
				expect(retained.state.value.kind).toBe("failed");
			});
			gateway.revoke("revoked", context);
			await vi.waitFor(() => expect(revoked.state.value.kind).toBe("ended"));
			await expect(revoked.ping(context)).rejects.toMatchObject({ code: "forbidden", reason: "revoked" });
			expect(retained.state.value.kind).toBe("failed");
			await server.reload(
				[
					{
						name: "value",
						facet: defineFacet((host) =>
							host.serve(Value, () => ({
								variant: "available",
								members: { value: constant(41), ping: async () => 41 },
							})),
						),
					},
				],
				context,
			);
			available = true;
			route?.retry(Service());
			await vi.waitFor(() => expect(retained.state.value.kind).toBe("live"));
			expect(retained.value.value).toBe(41);
			expect(await retained.ping(context)).toBe(41);
			expect(revoked.state.value.kind).toBe("ended");
		} finally {
			revoked.release();
			retained.release();
			await Promise.all(clients.map((client) => client.close(context)));
			if (relayed) await gateway.close(context);
			await server.close(context);
		}
	},
);
