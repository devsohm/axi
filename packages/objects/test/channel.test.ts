import { expect, it, vi } from "vitest";
import { NOOP_TELEMETRY_METRICS } from "@axi/telemetry";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import { Channel } from "../src/link/channel.ts";
import { memoryLinkPair } from "../src/link/link.ts";
import { textCodec } from "../src/link/text.ts";
import { objectsMetrics } from "../src/telemetry.ts";
const incarnation = "0190f5a2-7c3e-7d4a-9b1c-2d3e4f5a6b7c";
const flushed = () => new Promise((resolve) => setImmediate(resolve));

it("handshakes before sending work and retains ordered messages through repeated asynchronous handlers", async () => {
	const [local, peer] = memoryLinkPair(),
		seen: unknown[] = [],
		gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
	let next = 0;
	const channel = new Channel(
		local,
		{
			opened: () => seen.push("open"),
			closed: () => seen.push("closed"),
			message: (message) => {
				if (message.kind === "release" && message.hold === 0)
					return gates[next++]!.promise.then(() => {
						seen.push(0);
					});
				seen.push(message.kind === "release" ? message.hold : message.kind);
			},
		},
		{
			codec: textCodec,
			incarnation,
			calls: 256,
			trusted: false,
			report: (error) => {
				throw error;
			},
		},
		context,
	);
	const outgoing: unknown[] = [];
	peer.onMessage((bytes) => outgoing.push(textCodec.decode(bytes)));
	channel.send({ kind: "ack" });
	channel.start();
	await flushed();
	expect(outgoing).toEqual([
		{ kind: "hello", protocol: 1, incarnation, calls: 256 },
	]);
	peer.send(
		textCodec.encode({ kind: "hello", protocol: 1, incarnation, calls: 7 }),
	);
	await flushed();
	expect(channel.peerCalls).toBe(7);
	expect(outgoing.at(-1)).toEqual({ kind: "ack" });
	for (const hold of [0, 1, 0, 2])
		peer.send(textCodec.encode({ kind: "release", hold }));
	await flushed();
	expect(seen).toEqual(["open"]);
	gates[0]!.resolve();
	await flushed();
	expect(seen).toEqual(["open", 0, 1]);
	gates[1]!.resolve();
	await flushed();
	expect(seen).toEqual(["open", 0, 1, 0, 2]);
	channel.close();
	await flushed();
	expect(seen.at(-1)).toBe("closed");
});
it("reports a malformed handshake once and closes a peer that stays silent", async () => {
	vi.useFakeTimers();
	try {
		const [local, peer] = memoryLinkPair(),
			errors: unknown[] = [],
			ends: unknown[] = [];
		const channel = new Channel(
			local,
			{ opened() {}, message() {}, closed: () => ends.push("closed") },
			{
				codec: textCodec,
				incarnation,
				calls: 1,
				trusted: false,
				report: (error) => errors.push(error),
			},
			context,
		);
		channel.start();
		peer.send(textCodec.encode({ kind: "ack" }));
		await Promise.resolve();
		expect(channel.closed).toBe(true);
		expect(errors).toHaveLength(1);
		expect(ends).toEqual(["closed"]);
		const [other] = memoryLinkPair();
		const quiet = new Channel(
			other,
			{ opened() {}, message() {}, closed() {} },
			{ codec: textCodec, incarnation, calls: 1, trusted: true, report() {} },
			context,
		);
		quiet.start();
		quiet.tick(Date.now() + 30, 0, 15, 30);
		expect(quiet.closed).toBe(true);
	} finally {
		vi.useRealTimers();
	}
});
it("keeps heartbeat probes outside outgoing application-byte accounting", async () => {
	const [local, peer] = memoryLinkPair(), add = vi.fn();
	const channel = new Channel(
		local,
		{ opened() {}, message() {}, closed() {} },
		{
			codec: textCodec, incarnation, calls: 256, trusted: true, report() {},
			metrics: objectsMetrics({ ...NOOP_TELEMETRY_METRICS, counter: () => ({ add }) }),
		},
		context,
	);
	try {
		channel.start();
		peer.send(textCodec.encode({ kind: "hello", protocol: 1, incarnation, calls: 256 }));
		await flushed();
		add.mockClear();
		channel.tick(Date.now() + 20, 0, 10, 100);
		expect(add).not.toHaveBeenCalled();
		peer.send(textCodec.encode({ kind: "pong" }));
		await flushed();
		channel.send({ kind: "ack" });
		expect(add.mock.calls).toEqual([
			[textCodec.encode({ kind: "pong" }).byteLength, { direction: "received" }],
			[textCodec.encode({ kind: "ack" }).byteLength, { direction: "sent" }],
		]);
	} finally {
		channel.close();
	}
});
