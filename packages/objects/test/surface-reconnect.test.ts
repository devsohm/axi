import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import { createHost, hostKind, memoryLinkPair, startClient, WebScripts } from "../src/index.ts";
import { scriptsFacet } from "../src/node/surfaces/current.ts";
import { keepConnected, type ConnectionState, type SocketEvents } from "../src/surfaces/connection.ts";

function environment() {
	let wake: (() => void) | undefined;
	return {
		now: Date.now,
		online: () => true,
		after(ms: number, callback: () => void) {
			const timer = setTimeout(callback, ms);
			return () => clearTimeout(timer);
		},
		onWake(listener: () => void) {
			wake = listener;
			return () => {
				wake = undefined;
			};
		},
		wake() {
			wake?.();
		},
	};
}

function connection(canRetry: () => Promise<boolean>) {
	const clock = environment();
	const sockets: { events: SocketEvents; close(): void; closed: boolean }[] = [];
	const states: ConnectionState[] = [];
	const loop = keepConnected({
		environment: clock,
		canRetry,
		onState: (state) => states.push(state),
		open(events) {
			let listener: (() => void) | undefined;
			const socket = {
				events,
				closed: false,
				onClose(callback: () => void) {
					listener = callback;
				},
				close() {
					if (socket.closed) return;
					socket.closed = true;
					listener?.();
				},
			};
			sockets.push(socket);
			return socket;
		},
	});
	return { clock, sockets, states, loop };
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(0);
});
afterEach(() => vi.useRealTimers());

test("a slow retry decision permits reconnecting and a later refusal closes the replacement", async () => {
	const decision = Promise.withResolvers<boolean>();
	const { sockets, states, loop } = connection(() => decision.promise);
	try {
		sockets[0]!.close();
		await vi.advanceTimersByTimeAsync(250);
		expect(sockets).toHaveLength(2);
		sockets[1]!.events.opened();
		expect(states.at(-1)).toBe("connected");
		decision.resolve(false);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(sockets).toHaveLength(2);
		expect(sockets[1]!.closed).toBe(true);
		expect(states.at(-1)).toBe("waiting");
	} finally {
		decision.resolve(false);
		loop.stop();
	}
});

test("successive failed connections share one pending retry question", async () => {
	const answers: ((again: boolean) => void)[] = [];
	const { sockets, loop } = connection(() => new Promise((resolve) => answers.push(resolve)));
	try {
		for (let attempt = 0; attempt < 6; attempt++) {
			sockets.at(-1)!.close();
			await vi.advanceTimersByTimeAsync(5000);
		}
		expect(sockets).toHaveLength(7);
		expect(answers).toHaveLength(1);
		answers[0]!(true);
		await vi.advanceTimersByTimeAsync(0);
		sockets.at(-1)!.close();
		expect(answers).toHaveLength(2);
	} finally {
		for (const answer of answers) answer(false);
		loop.stop();
	}
});

test("a close after waking retries immediately once, then resumes ordinary backoff", async () => {
	const { clock, sockets, loop } = connection(async () => true);
	try {
		sockets[0]!.events.opened();
		await vi.advanceTimersByTimeAsync(10_000);
		clock.wake();
		sockets[0]!.close();
		await vi.advanceTimersByTimeAsync(0);
		expect(sockets).toHaveLength(2);
		sockets[1]!.close();
		await vi.advanceTimersByTimeAsync(499);
		expect(sockets).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(1);
		expect(sockets).toHaveLength(3);
	} finally {
		loop.stop();
	}
});

test("an outdated-client callback observes the replacement link already closed", async () => {
	const server = createHost({ address: hostKind("server")(), principal: { kind: "server" }, onError() {} });
	await server.load(
		[{ name: "scripts", facet: scriptsFacet("web", { set: { base: "one", combined: "/all.js", plugins: [] } }) }],
		context,
	);
	const answer = Promise.withResolvers<string>();
	const links: { close(): void; closed: boolean }[] = [];
	const states: ConnectionState[] = [];
	const observed: { state: ConnectionState | undefined; closed: boolean | undefined }[] = [];
	const client = await startClient({
		scripts: WebScripts,
		base: "one",
		initial: [],
		modules: {},
		core: [],
		environment: environment(),
		fetchScript: async () => {
			throw new Error("No script was advertised");
		},
		serverBase: () => answer.promise,
		outdated: () => observed.push({ state: states.at(-1), closed: links.at(-1)?.closed }),
		onConnection: (state) => states.push(state),
		onError() {},
		open(events) {
			const [local, remote] = memoryLinkPair();
			const tracked = {
				close() {
					tracked.closed = true;
					local.close();
				},
				closed: false,
			};
			links.push(tracked);
			server.accept(remote, { principal: { kind: "user" } }, context);
			queueMicrotask(events.opened);
			return {
				send: (message) => local.send(message),
				onMessage: (listener) => local.onMessage(listener),
				onClose: (listener) => local.onClose(listener),
				close: tracked.close,
			};
		},
	});
	try {
		links[0]!.close();
		await vi.advanceTimersByTimeAsync(250);
		expect(links).toHaveLength(2);
		expect(states.at(-1)).toBe("connected");
		answer.resolve("two");
		await vi.advanceTimersByTimeAsync(0);
		expect(observed).toEqual([{ state: "waiting", closed: true }]);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(links).toHaveLength(2);
	} finally {
		answer.resolve("two");
		await client.stop(context);
		await server.close(context);
	}
});
