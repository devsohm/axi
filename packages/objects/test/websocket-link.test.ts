import { once } from "node:events";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { expect, test } from "vitest";
import { webSocketLink } from "../src/link/index.ts";

test("a real WebSocket link queues early sends, exchanges binary frames and closes on nonbinary input", async () => {
	const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Expected a TCP address");
	const connected = once(server, "connection");
	const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
	const link = webSocketLink(socket);
	const closed = Promise.withResolvers<void>();
	link.onClose(closed.resolve);
	link.send(new Uint8Array([1, 2, 3]));
	try {
		const [peer] = await connected;
		const [queued] = await once(peer, "message");
		expect(new Uint8Array(queued)).toEqual(new Uint8Array([1, 2, 3]));
		const message = Promise.withResolvers<Uint8Array>();
		link.onMessage(message.resolve);
		peer.send(new Uint8Array([4, 5, 6]));
		expect(await message.promise).toEqual(new Uint8Array([4, 5, 6]));
		const peerClosed = once(peer, "close");
		peer.send("text frames are not the link protocol");
		await closed.promise;
		await peerClosed;
		link.send(new Uint8Array([7]));
		link.close();
		let ended = false;
		webSocketLink(socket).onClose(() => {
			ended = true;
		});
		expect(ended).toBe(true);
	} finally {
		link.close();
		for (const peer of server.clients) peer.terminate();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

test("a failed WebSocket handshake ends the link and releases its queued messages", async () => {
	const server = createServer((_request, response) => {
		response.writeHead(403);
		response.end();
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Expected a TCP address");
	const link = webSocketLink(new WebSocket(`ws://127.0.0.1:${address.port}`));
	const closed = Promise.withResolvers<void>();
	link.onClose(closed.resolve);
	link.send(new Uint8Array([1]));
	try {
		await closed.promise;
		link.close();
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
