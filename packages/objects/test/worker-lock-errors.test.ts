import * as net from "node:net";
import { expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import { lockAt } from "../src/node/workers/lock.ts";

vi.mock("node:net", async (importOriginal) => {
	const original = await importOriginal<typeof net>();
	return { ...original, connect: vi.fn(original.connect), createServer: vi.fn(original.createServer) };
});

it.each(["ECONNREFUSED", "ENOTSOCK"])("refuses a stale file lock after %s without retrying", async (code) => {
	const server = new net.Server();
	const socket = new net.Socket();
	const listen = vi.spyOn(server, "listen").mockImplementation(() => {
		if (listen.mock.calls.length > 1) throw new Error("unexpected retry");
		queueMicrotask(() => server.emit("error", Object.assign(new Error("occupied"), { code: "EADDRINUSE" })));
		return server;
	});
	vi.mocked(net.createServer).mockReturnValue(server);
	vi.mocked(net.connect).mockImplementation(() => {
		queueMicrotask(() => {
			socket.emit("error", Object.assign(new Error("not listening"), { code }));
			socket.destroy();
		});
		return socket;
	});
	try {
		await expect(lockAt({ kind: "file", address: "/missing/lock.sock" }, context)).rejects.toThrow("is a stale lock file");
		expect(listen).toHaveBeenCalledTimes(1);
	} finally {
		vi.restoreAllMocks();
		socket.destroy();
	}
});
