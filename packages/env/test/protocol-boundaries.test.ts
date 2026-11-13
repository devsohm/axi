import { fileURLToPath } from "node:url";
import { expect, test, vi } from "vitest";
import { Connection, isConnectionLost, nodePlatform } from "../src/connection.ts";

const peer = [process.execPath, fileURLToPath(new URL("./fixtures/peer.ts", import.meta.url))];
function frame(type: number, body: string, declared = Buffer.byteLength(body)): Buffer {
	const bytes = Buffer.from(body),
		packet = Buffer.alloc(13 + bytes.length);
	packet.writeUInt32BE(packet.length - 4, 0);
	packet[4] = type;
	packet.writeUInt32BE(0xffff, 5);
	packet.writeUInt32BE(declared, 9);
	packet.set(bytes, 13);
	return packet;
}

test.each([
	{ name: "truncated frame", packet: Buffer.from([0, 0, 0, 8]) },
	{ name: "oversized frame", packet: Buffer.from([1, 0, 0, 1]) },
	{ name: "mismatched JSON length", packet: frame(2, "{}", 100) },
	...["null", "[]", "3", "broken"].map((text) => ({ name: `invalid response body ${text}`, packet: frame(2, text) })),
])("$name rejects the request and a fresh daemon remains usable", async ({ packet }) => {
	const connection = new Connection({ command: peer });
	try {
		const first = (await connection.info()).pid;
		await expect(connection.request("raw", {}, { payload: packet })).rejects.toSatisfy(isConnectionLost);
		expect((await connection.request("echo", { value: "recovered" })).json).toEqual({ value: "recovered" });
		expect((await connection.info()).pid).not.toBe(first);
	} finally {
		connection.close();
	}
}, 15000);

test("well-formed unknown frames and stale responses do not disturb the pending request", async () => {
	const connection = new Connection({ command: peer });
	try {
		const reply = await connection.request(
			"raw",
			{},
			{ payload: Buffer.concat([frame(99, "{}"), frame(2, '{"value":"stale"}'), frame(4, '{"kind":"unknown"}')]) },
		);
		expect(reply.json).toEqual({ accepted: true });
		expect((await connection.request("echo", { value: 7 })).json.value).toBe(7);
	} finally {
		connection.close();
	}
});

test("remote error defaults remain strings and unknown platform names pass through", async () => {
	const connection = new Connection({ command: peer });
	try {
		await expect(
			connection.request("remote-error", { error: { code: null, message: false, path: 7 } }),
		).rejects.toMatchObject({ code: "unknown", message: "Remote operation failed", path: undefined });
		await expect(
			connection.request("remote-error", { error: { code: "EACCES", message: "denied", path: "/private" } }),
		).rejects.toMatchObject({ code: "EACCES", message: "denied", path: "/private" });
		expect(nodePlatform({ os: "other-os", arch: "riscv64" })).toEqual({ platform: "other-os", arch: "riscv64" });
		expect(nodePlatform({ os: "macos", arch: "aarch64" })).toEqual({ platform: "darwin", arch: "arm64" });
	} finally {
		connection.close();
	}
});

test("kill cancels only the current daemon session's request", async () => {
	const connection = new Connection({ command: peer });
	const started = Promise.withResolvers<{ id: number; session: number }>();
	try {
		let settled = false;
		const pending = connection.request("hold", {}, { onStart: (id, session) => started.resolve({ id, session }) });
		const rejected = expect(
			pending.finally(() => {
				settled = true;
			}),
		).rejects.toMatchObject({ code: "aborted" });
		const { id, session } = await started.promise;
		connection.kill(id, session + 1);
		await connection.request("echo", { value: "barrier" });
		expect(settled).toBe(false);
		connection.kill(id, session);
		await rejected;
		expect((await connection.request("echo", { value: "ready" })).json.value).toBe("ready");
	} finally {
		connection.close();
	}
});

test("startup diagnostics strip terminal controls and keep actionable stderr on protocol refusal", async () => {
	const failed = new Connection({
		command: [
			process.execPath,
			"-e",
			'process.stderr.write("\\x1b[31mauth failed\\x1b[0m\\r\\nreason\\x00\\x01\\n"); process.exit(7);',
		],
	});
	try {
		await expect(failed.info()).rejects.toMatchObject({ message: expect.stringContaining("auth failed\nreason") });
	} finally {
		failed.close();
	}
	const unsupported = new Connection({ command: [...peer, "--protocol", "99"] });
	try {
		await expect(unsupported.info()).rejects.toMatchObject({
			message: expect.stringContaining("Unsupported protocol 99"),
		});
	} finally {
		unsupported.close();
	}
	const empty = new Connection({ command: [] });
	try {
		await expect(empty.info()).rejects.toMatchObject({ code: "spawn_error", message: "No daemon command" });
	} finally {
		empty.close();
	}
});

test("large shell preambles are bounded while synchronization still finds the daemon banner", async () => {
	const logs: string[] = [],
		connection = new Connection({ command: [...peer, "--long-preamble"], onLog: (line) => logs.push(line) });
	try {
		expect((await connection.info()).protocol).toBe(1);
		expect(logs.join("")).toMatch(/shell startup$/);
		expect(Buffer.byteLength(logs.join(""))).toBeLessThan(1024 * 1024);
	} finally {
		connection.close();
	}
});

test("the handshake deadline closes an unresponsive daemon", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const connection = new Connection({ command: [...peer, "--no-hello"] });
	try {
		const rejection = expect(connection.info()).rejects.toMatchObject({
			message: expect.stringContaining("did not answer within 60 s"),
		});
		await vi.advanceTimersByTimeAsync(60_000);
		await rejection;
	} finally {
		connection.close();
		vi.useRealTimers();
	}
});

test("heartbeat expiry rejects outstanding work when the daemon stops answering", async () => {
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
	const connection = new Connection({ command: peer });
	try {
		await connection.info();
		const started = Promise.withResolvers<void>();
		const rejection = expect(
			connection.request("hold", {}, { onStart: () => started.resolve() }),
		).rejects.toMatchObject({ message: expect.stringContaining("connection timed out") });
		await started.promise;
		await vi.advanceTimersByTimeAsync(35_000);
		await rejection;
	} finally {
		connection.close();
		vi.useRealTimers();
	}
});
