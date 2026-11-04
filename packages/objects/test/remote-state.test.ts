import { expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import { constant, createHost, defineFacet, hostKind, int, memoryLinkPair, method, remote } from "../src/index.ts";
import { ObjectsError } from "../src/data/index.ts";
import { CallWindow } from "../src/remote/calls.ts";
import { Replica } from "../src/remote/replica.ts";
import { Batch } from "../src/state/internal.ts";
import { nodeCompression } from "../src/node/compression.ts";

it("uses the same variant index at both ends when declarations are not alphabetical", async () => {
	const Server = hostKind("variant.server");
	const View = remote("variant.view", {
		version: 1,
		params: {},
		hostAddress: () => Server(),
		variants: {
			writer: { state: { total: int() }, methods: { echo: method(int(), int()) } },
			reader: { state: { total: int() }, methods: { echo: method(int(), int()) } },
		},
	});
	type Principal = { kind: string };
	const server = createHost<Principal>({ address: Server(), principal: { kind: "server" }, onError: () => {} });
	const clients: ReturnType<typeof createHost<Principal>>[] = [];
	try {
		await server.load(
			[
				{
					name: "views",
					facet: defineFacet<Principal>((h) =>
						h.serve(View, (_, principal) => ({
							variant: principal.kind === "writer" ? "writer" : "reader",
							members: { total: constant(principal.kind === "writer" ? 17 : 4), echo: async (n: number) => n },
						})),
					),
				},
			],
			context,
		);
		for (const role of ["writer", "reader"]) {
			const client = createHost<Principal>({ onError: () => {} });
			clients.push(client);
			await client.load([], context);
			const [incoming, outgoing] = memoryLinkPair();
			server.accept(incoming, { principal: { kind: role } }, context);
			client.connect(outgoing, { principal: { kind: "server" } }, context);
			const ref = await client.get(View, {}, context);
			expect(ref.variant).toBe(role);
			expect(ref.total.value).toBe(role === "writer" ? 17 : 4);
			expect(await ref.echo(8, context)).toBe(8);
		}
	} finally {
		await Promise.all(clients.map((client) => client.close(context)));
		await server.close(context);
	}
});

it("enforces an announced call window and removes cancelled or rebound queued calls", () => {
	const window = new CallWindow(),
		sent: string[] = [];
	const first = {
			hold: 1,
			send() {
				sent.push("first");
			},
		},
		stale = {
			hold: 2,
			send() {
				sent.push("stale");
			},
		},
		last = {
			hold: 3,
			send() {
				sent.push("last");
			},
		};
	for (const call of [first, stale, last]) window.submit(call);
	expect(sent).toEqual([]);
	window.opened(1);
	expect(sent).toEqual(["first"]);
	expect(window.removeHold(2)).toEqual([stale]);
	window.freed();
	expect(sent).toEqual(["first", "last"]);
	expect(window.clear()).toEqual([]);
});
it("preserves retirement through a failed replica and recovers from a full replacement", async () => {
	const batch = new Batch(() => {}, undefined),
		replica = new Replica(batch, { kind: "value", value: { n: 1 } }),
		seen: unknown[] = [];
	const watch = await replica.watch(context);
	watch.start(async (call) => {
		seen.push(call);
	});
	const failure = new Error("lost");
	batch.commit(() => replica.fail(failure), context);
	for (let i = 0; i < 6; i++) await Promise.resolve();
	batch.commit(() => replica.retireAlone(), context);
	expect(() => replica.decode([["s", ["n"], 2]])).toThrow("root replacement");
	const { value, ops } = replica.decode([["r", { n: 3 }]]);
	batch.commit(() => replica.adopt(value, ops, false), context);
	for (let i = 0; i < 6; i++) await Promise.resolve();
	expect(seen).toEqual([
		{ kind: "failed", error: failure },
		{ kind: "value", value: { n: 3 }, ops: [["r", { n: 3 }]], retired: true },
	]);
	replica.end(new ObjectsError({ code: "released", message: "ended" }));
	expect(await watch.closed).toEqual({ kind: "ended" });
});
it("bounds raw-deflate expansion and distinguishes corrupt input", () => {
	const value = new TextEncoder().encode("x".repeat(10000)),
		compressed = nodeCompression.deflate(value);
	const inflated = nodeCompression.inflate(compressed, 10000);
	if (inflated.kind !== "bytes") throw new Error("Expected inflated bytes");
	expect([...inflated.bytes]).toEqual([...value]);
	expect(nodeCompression.inflate(compressed, 9999)).toEqual({ kind: "too_large" });
	expect(nodeCompression.inflate(compressed, 0)).toEqual({ kind: "too_large" });
	expect(nodeCompression.inflate(new Uint8Array([255]), 100).kind).toBe("corrupt");
});
