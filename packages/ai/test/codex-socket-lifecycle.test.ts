import { afterEach, expect, test, vi } from "vitest";
import {
	closeOpenAICodexWebSocketSessions,
	getOpenAICodexWebSocketDebugStats,
	resetOpenAICodexWebSocketDebugStats,
	runCodexWebSocket,
} from "../src/api/openai-codex-websocket.ts";

type Listener = (event: unknown) => void;
class Socket {
	readyState = 0;
	readonly listeners = new Map<string, Set<Listener>>();
	readonly closed: { code?: number; reason?: string }[] = [];
	readonly sent: string[] = [];
	readonly sendFrames: (socket: Socket) => void;
	constructor(sendFrames: (socket: Socket) => void = () => {}) {
		this.sendFrames = sendFrames;
	}
	addEventListener(type: string, listener: Listener) {
		let group = this.listeners.get(type);
		if (!group) this.listeners.set(type, (group = new Set()));
		group.add(listener);
	}
	removeEventListener(type: string, listener: Listener) {
		this.listeners.get(type)?.delete(listener);
	}
	emit(type: string, event: unknown) {
		for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
	}
	send(value: string) {
		this.sent.push(value);
		queueMicrotask(() => this.sendFrames(this));
	}
	close(code?: number, reason?: string) {
		this.readyState = 3;
		this.closed.push({ code, reason });
	}
	get listenerCount() {
		return [...this.listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0);
	}
}
function sockets(connect: (socket: Socket) => void, send?: (socket: Socket) => void) {
	const created: Socket[] = [];
	vi.stubGlobal(
		"WebSocket",
		class extends Socket {
			constructor() {
				super(send);
				created.push(this);
				queueMicrotask(() => connect(this));
			}
		},
	);
	return created;
}
const opened = (socket: Socket) => {
	socket.readyState = 1;
	socket.emit("open", {});
};
const complete = (socket: Socket) => socket.emit("message", { data: '{"type":"response.completed"}' });
function run(options: Partial<Parameters<typeof runCodexWebSocket>[0]> = {}) {
	return runCodexWebSocket({
		url: "wss://provider.invalid/responses",
		headers: new Headers(),
		body: { model: "test" },
		session: undefined,
		account: "account",
		signal: undefined,
		connectTimeout: 1000,
		idleTimeout: 1000,
		cached: false,
		async consume(events) {
			for await (const _event of events) {
			}
			return { responseId: "response", items: [] };
		},
		...options,
	});
}
afterEach(() => {
	closeOpenAICodexWebSocketSessions();
	resetOpenAICodexWebSocketDebugStats();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

test.each([
	[undefined, "WebSocket error"],
	[null, "WebSocket error"],
	[42, "WebSocket error"],
	[{ message: "connection refused" }, "connection refused"],
	[{ error: new Error("nested failure") }, "nested failure"],
	[{ error: { message: "nested message" } }, "nested message"],
	[{ error: { message: "" } }, "WebSocket error"],
] satisfies [unknown, string][])("connection errors retain their useful diagnostic for %j", async (event, message) => {
	const created = sockets((socket) => socket.emit("error", event));
	await expect(run()).rejects.toThrow(message);
	expect(created[0]?.listenerCount).toBe(0);
});

test.each([
	[undefined, "WebSocket closed"],
	[{}, "WebSocket closed"],
	[{ code: 1009 }, "WebSocket closed 1009 message too big"],
	[{ code: 1000, reason: "peer shutdown", wasClean: true }, "WebSocket closed 1000 peer shutdown"],
] satisfies [unknown, string][])("connection closure reports its code and reason for %j", async (event, message) => {
	const created = sockets((socket) => socket.emit("close", event));
	await expect(run()).rejects.toThrow(message);
	expect(created[0]?.listenerCount).toBe(0);
});

test("a connection deadline closes the unfinished socket and detaches its listeners", async () => {
	const created = sockets(() => {});
	await expect(run({ connectTimeout: 5 })).rejects.toThrow("WebSocket connect timeout after 5ms");
	expect(created[0]?.closed).toEqual([{ code: 1000, reason: "connect_timeout" }]);
	expect(created[0]?.listenerCount).toBe(0);
});

test("cancelling a pending connection closes its socket and removes the abort listener", async () => {
	const controller = new AbortController();
	const created = sockets(() => controller.abort());
	await expect(run({ signal: controller.signal })).rejects.toThrow("Request was aborted");
	expect(created[0]?.closed).toEqual([{ code: 1000, reason: "aborted" }]);
	expect(created[0]?.listenerCount).toBe(0);
});

test.each([
	[undefined, "WebSocket transport is not available"],
	[
		function InvalidSocket() {
			return {};
		},
		"WebSocket constructor returned an invalid socket",
	],
	[
		function FailedSocket() {
			throw "constructor rejected";
		},
		"constructor rejected",
	],
] satisfies [unknown, string][])(
	"unavailable or invalid socket constructors fail cleanly: %s",
	async (constructor, message) => {
		vi.stubGlobal("WebSocket", constructor);
		await expect(run()).rejects.toThrow(message);
	},
);

test.each(["array-buffer", "typed-array", "blob"] as const)(
	"%s frames decode into response events and clean up after completion",
	async (format) => {
		const bytes = new TextEncoder().encode('{"type":"response.completed"}');
		const data = format === "array-buffer" ? bytes.buffer : format === "typed-array" ? bytes : new Blob([bytes]);
		const received: unknown[] = [];
		const created = sockets(opened, (socket) => {
			socket.emit("message", undefined);
			socket.emit("message", { data: null });
			socket.emit("message", { data: { arrayBuffer: async () => "not bytes" } });
			socket.emit("message", { data });
		});
		await run({
			async consume(events) {
				for await (const event of events) received.push(event);
				return { items: [] };
			},
		});
		expect(received).toEqual([{ type: "response.completed" }]);
		expect(created[0]?.closed).toEqual([{ code: 1000, reason: "done" }]);
		expect(created[0]?.listenerCount).toBe(0);
	},
);

test("failed binary-frame decoding rejects the run with a protocol error", async () => {
	const created = sockets(opened, (socket) =>
		socket.emit("message", {
			data: {
				arrayBuffer: async () => {
					throw new Error("binary frame lost");
				},
			},
		}),
	);
	await expect(run()).rejects.toMatchObject({
		name: "CodexProtocolError",
		message: expect.stringContaining("binary frame lost"),
	});
	expect(created[0]?.listenerCount).toBe(0);
	expect(created[0]?.closed).toHaveLength(1);
});

test("idle cached sockets expire and debug snapshots cannot mutate the stored counters", async () => {
	vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
	const created = sockets(opened, complete);
	await run({ session: "idle-session", cached: true });
	const stats = getOpenAICodexWebSocketDebugStats("idle-session");
	if (!stats) throw new Error("Missing session debug counters");
	stats.requests = 100;
	expect(getOpenAICodexWebSocketDebugStats("idle-session")?.requests).toBe(1);
	await vi.advanceTimersByTimeAsync(5 * 60_000);
	expect(created[0]?.closed).toEqual([{ code: 1000, reason: "idle_timeout" }]);
	await run({ session: "idle-session", cached: true });
	expect(created).toHaveLength(2);
	expect(getOpenAICodexWebSocketDebugStats("idle-session")).toMatchObject({
		requests: 2,
		connectionsCreated: 2,
		connectionsReused: 0,
	});
	closeOpenAICodexWebSocketSessions("idle-session");
	expect(created[1]?.closed).toEqual([{ code: 1000, reason: "debug_close" }]);
	resetOpenAICodexWebSocketDebugStats("idle-session");
	expect(getOpenAICodexWebSocketDebugStats("idle-session")).toBeUndefined();
});
