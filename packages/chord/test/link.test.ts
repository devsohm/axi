import assert from "node:assert/strict";
import { once } from "node:events";
import { describe, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import {
	inflateMessage,
	type IpcChannel,
	ipcLink,
	memoryLinkPair,
	Packed,
	unpack,
	type WebSocketLike,
	webSocketLink,
} from "../src/link.ts";
import { fromWireError, isFrame, PROTOCOL_VERSION, toWireError, type Frame } from "../src/wire.ts";
import { ChordError } from "../src/errors.ts";
import { createHost } from "../src/host.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const large = "hello 🌍".repeat(12000);

describe("frame channels", () => {
	it("rejects an impossible acknowledgement after a valid handshake", async () => {
		const errors: unknown[] = [];
		const host = createHost({ self: null, onError: (error) => errors.push(error) });
		const [downstream, peer] = memoryLinkPair();
		const frames: Frame[] = [];
		const reasons: string[] = [];
		peer.receive((frame) => frames.push(frame));
		peer.onClose((reason) => reasons.push(reason));
		try {
			host.accept(downstream, { principal: "client" });
			peer.send({ t: "hello", protocol: PROTOCOL_VERSION, name: "client", kind: "client", codeVersion: 0, acks: true });
			peer.send({ t: "ping", n: 7 });
			await tick();
			assert.equal(peer.closed, false);
			assert.deepEqual(
				frames.find((frame) => frame.t === "pong"),
				{ t: "pong", n: 7 },
			);
			peer.send({ t: "ack", n: 99 });
			await tick();
			assert.equal(peer.closed, true);
			assert.match(reasons[0], /^protocol error: ack 99 outside 0\.\.[0-9]+$/);
			assert.equal(errors.length, 1);
			assert(errors[0] instanceof ChordError);
			assert.equal(errors[0].reason, "protocol");
		} finally {
			await host.close();
		}
	});
	it("reads wire error fields in serialization and construction order", () => {
		const encodedReads: string[] = [];
		const cause = new ChordError("invalid", "bad", { reason: "schema" });
		for (const key of ["code", "message", "reason"] as const) {
			const value = cause[key];
			Object.defineProperty(cause, key, {
				get() {
					encodedReads.push(key);
					return value;
				},
			});
		}
		const wire = toWireError(cause);
		assert.deepEqual(encodedReads, ["reason", "code", "message", "reason"]);
		const decodedReads: string[] = [];
		const decoded = fromWireError(
			new Proxy(wire, {
				get(target, key, receiver) {
					decodedReads.push(String(key));
					return Reflect.get(target, key, receiver);
				},
			}),
		);
		assert.deepEqual(decodedReads, ["code", "message", "reason"]);
		assert.equal(decoded.message, "invalid/schema: bad");
	});
	it("captures a message event payload with one read", () => {
		let receive: ((event: { data: unknown }) => void) | undefined;
		const registrations: string[] = [];
		const socket: WebSocketLike = {
			readyState: 1,
			send() {},
			close() {},
			addEventListener(type, listener) {
				registrations.push(type);
				if (type === "message") receive = listener;
			},
		};
		const link = webSocketLink(socket);
		const frames: Frame[] = [];
		link.receive((frame) => frames.push(frame));
		let reads = 0;
		receive?.({
			get data() {
				return ++reads === 1 ? '{"t":"ping","n":1}' : "invalid";
			},
		});
		assert.deepEqual(registrations, ["open", "message", "close"]);
		assert.equal(reads, 1);
		assert.deepEqual(frames, [{ t: "ping", n: 1 }]);
		assert.equal(link.closed, false);
		link.close();
	});

	it("retains its packed-frame policy when the caller changes the options object", () => {
		let receive: ((event: { data: unknown }) => void) | undefined;
		let packet: string | Uint8Array | undefined;
		const socket: WebSocketLike = {
			readyState: 1,
			send(value) {
				packet = value;
			},
			close() {},
			addEventListener(type, listener) {
				if (type === "message") receive = listener;
			},
		};
		const options = { acceptPacked: false, compress: true };
		const link = webSocketLink(socket, options);
		let frames = 0;
		link.receive(() => frames++);
		link.send({ t: "result", id: 1, value: large });
		assert(packet instanceof Uint8Array);
		options.acceptPacked = true;
		receive?.({ data: packet });
		assert.equal(link.closed, true);
		assert.equal(frames, 0);
	});
	it("delivers queued messages asynchronously, in order, detached from their senders", async () => {
		const [a, b] = memoryLinkPair();
		const data = { n: 1 };
		assert.equal(typeof a.send({ t: "result", id: 1, value: data }), "number");
		data.n = 9;
		a.send({ t: "ping", n: 2 });
		const received: Frame[] = [];
		assert.equal(received.length, 0);
		await tick();
		b.receive((frame) => received.push(frame));
		assert.deepEqual(received, [
			{ t: "result", id: 1, value: { n: 1 } },
			{ t: "ping", n: 2 },
		]);
		a.close("finished");
		await tick();
		assert.equal(a.closed, true);
		assert.equal(b.closed, true);
	});

	it("notifies each close listener once and prevents further transmission", async () => {
		const [a, b] = memoryLinkPair();
		const seen: string[] = [];
		b.onClose((reason) => seen.push(reason));
		a.close("complete");
		a.close("again");
		await tick();
		b.onClose((reason) => seen.push(reason));
		assert.deepEqual(seen, ["complete", "closed"]);
		assert.equal(a.send({ t: "ping", n: 1 }), undefined);
	});

	it("simulates a silent disconnection in both directions", async () => {
		const [a, b] = memoryLinkPair();
		const frames: Frame[] = [];
		b.receive((frame) => frames.push(frame));
		a.send({ t: "ping", n: 1 });
		a.sever();
		assert.equal(b.send({ t: "pong", n: 1 }), undefined);
		await tick();
		assert.deepEqual(frames, []);
		assert.equal(a.closed, false);
		assert.equal(b.closed, false);
		a.close();
		await tick();
	});

	it("packs large payloads and preserves the compressed bytes through a relay", async () => {
		const [a, b] = memoryLinkPair(),
			[c, d] = memoryLinkPair();
		const received: Frame[] = [];
		b.receive((frame) => c.send(frame));
		d.receive((frame) => received.push(frame));
		a.send({ t: "result", id: 1, value: large });
		a.send({ t: "result", id: 2, value: "small" });
		await tick();
		const [first, second] = received;
		assert(first.t === "result" && first.value instanceof Packed);
		assert.equal(unpack(first.value), large);
		assert(second.t === "result");
		assert.equal(second.value, "small");
		a.close();
		c.close();
		await tick();
	});

	it("turns an IPC write failure into closure and unregisters its listeners", async () => {
		const removed: string[] = [];
		let writes = 0;
		const channel: IpcChannel = {
			connected: true,
			send(_message, callback) {
				writes++;
				process.nextTick(() => callback?.(Object.assign(new Error("pipe"), { code: "EPIPE" })));
				return false;
			},
			on() {},
			off(event) {
				removed.push(event);
			},
		};
		const link = ipcLink(channel),
			reasons: string[] = [];
		link.onClose((reason) => reasons.push(reason));
		link.send({ t: "ping", n: 1 });
		await tick();
		assert.deepEqual(reasons, ["ipc send failed: EPIPE"]);
		assert.deepEqual(removed, ["message", "disconnect"]);
		link.send({ t: "ping", n: 2 });
		assert.equal(writes, 1);
	});

	it("exchanges queued and packed frames across real WebSockets", async () => {
		const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
		await once(server, "listening");
		const address = server.address();
		assert(address !== null && typeof address === "object");
		const accepted = once(server, "connection");
		const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
		const client = webSocketLink(socket),
			packets: Uint8Array[] = [];
		socket.addEventListener("message", (event) => {
			if (event.data instanceof ArrayBuffer) packets.push(new Uint8Array(event.data));
		});
		client.send({ t: "ping", n: 3 });
		const [peer] = await accepted;
		const provider = webSocketLink(peer, { compress: true, acceptPacked: false });
		const answer = new Promise<Frame>((resolve) => client.receive(resolve));
		provider.receive((frame) => {
			assert.deepEqual(frame, { t: "ping", n: 3 });
			provider.send({ t: "result", id: 3, value: large });
		});
		try {
			const frame = await answer;
			assert(frame.t === "result");
			assert.equal(unpack(frame.value), large);
			assert.equal(packets.length, 1);
			assert.deepEqual(JSON.parse(inflateMessage(packets[0])), { t: "result", id: 3, value: large });
			const ended = new Promise<void>((resolve) => provider.onClose(() => resolve()));
			socket.send(new Uint8Array([0, 0, 0, 2, 123, 125]));
			await ended;
			assert.equal(provider.closed, true);
		} finally {
			client.close();
			provider.close();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});

it("checks protocol fields without rejecting contract payloads early", () => {
	assert.equal(isFrame({ t: "ping", n: -1 }), true);
	assert.equal(isFrame({ t: "ack", n: 0 }), false);
	assert.equal(isFrame({ t: "call", id: 1, hold: 2, member: "run", args: undefined }), true);
	assert.equal(isFrame({ t: "call", id: 1, hold: 2, member: "" }), false);
	assert.equal(isFrame({ t: "state", hold: 1, m: "state", as: "ops", ops: [["anything"]] }), true);
	assert.equal(isFrame({ t: "prepare", reload: 1, codeVersion: 2, plugins: [], options: {} }), true);
	assert.equal(isFrame({ t: "unknown" }), false);
});

it("preserves typed error identity across wire conversion", () => {
	const original = new ChordError("invalid", "bad input", { reason: "input" });
	const restored = fromWireError(toWireError(original));
	assert.equal(restored.code, "invalid");
	assert.equal(restored.reason, "input");
	assert.equal(restored.message, original.message);
	assert.deepEqual(toWireError("failure"), { code: "unavailable", message: "failure" });
});
