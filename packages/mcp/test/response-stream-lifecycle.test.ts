import { afterEach, expect, test, vi } from "vitest";
import { StreamableHttpTransport } from "../src/transports/streamable-http.ts";
import type { JsonRpcMessage } from "../src/index.ts";

afterEach(() => vi.useRealTimers());

const request = { jsonrpc: "2.0", id: 7, method: "work" } as const;
function stream(withCursor: boolean) {
	return new Response(`${withCursor ? "id: cursor\n" : ""}data: {"jsonrpc":"2.0","method":"working"}\n\n`, {
		headers: { "content-type": "text/event-stream" },
	});
}

test.each(["unauthorized", "network", "permanent", "absent"] as const)(
	"an unanswered response stream settles its request after %s recovery",
	async (failure) => {
		let gets = 0;
		const messages: JsonRpcMessage[] = [];
		const transport = new StreamableHttpTransport({
			url: "https://peer.invalid/mcp",
			openGetStream: false,
			reconnect: { initialDelayMs: 1, maxDelayMs: 1, maxRetries: 2 },
			fetch: async (_url, init) => {
				if (init?.method !== "GET") return stream(true);
				gets++;
				if (failure === "network") throw new TypeError("Disconnected");
				if (failure === "permanent") throw new Error("Rejected recovery");
				return new Response(null, { status: failure === "unauthorized" ? 401 : 405 });
			},
		});
		transport.onMessage((message) => messages.push(message));
		try {
			await transport.start();
			await transport.send(request);
			await vi.waitFor(() => expect(messages.some((message) => "id" in message && message.id === 7)).toBe(true));
			const cause = {
				unauthorized: "requires authentication",
				network: "Disconnected",
				permanent: "Rejected recovery",
				absent: "stream ended without a response",
			}[failure];
			expect(messages).toContainEqual({
				jsonrpc: "2.0",
				id: 7,
				error: { code: -32603, message: expect.stringContaining(cause) },
			});
			expect(gets).toBe(failure === "network" || failure === "absent" ? 2 : 1);
		} finally {
			await transport.close();
		}
	},
);

test("closing while a response stream waits to reconnect cancels the pending GET", async () => {
	vi.useFakeTimers();
	let gets = 0;
	const messages: JsonRpcMessage[] = [];
	const transport = new StreamableHttpTransport({
		url: "https://peer.invalid/mcp",
		openGetStream: false,
		fetch: async (_url, init) => {
			if (init?.method === "GET") {
				gets++;
				return new Response(null, { status: 405 });
			}
			return stream(true);
		},
	});
	transport.onMessage((message) => messages.push(message));
	try {
		await transport.start();
		await transport.send(request);
		await vi.advanceTimersByTimeAsync(0);
		await transport.close();
		await vi.advanceTimersByTimeAsync(60000);
		expect(gets).toBe(0);
		expect(messages).toEqual([{ jsonrpc: "2.0", method: "working" }]);
	} finally {
		await transport.close();
	}
});

test("closing during a failed response-stream reconnect cannot emit a late error reply", async () => {
	vi.useFakeTimers();
	const messages: JsonRpcMessage[] = [];
	let gets = 0;
	const transport = new StreamableHttpTransport({
		url: "https://peer.invalid/mcp",
		openGetStream: false,
		reconnect: { initialDelayMs: 1 },
		fetch: async (_url, init) => {
			if (init?.method !== "GET") return stream(true);
			gets++;
			await transport.close();
			throw new Error("Disconnected during shutdown");
		},
	});
	transport.onMessage((message) => messages.push(message));
	try {
		await transport.start();
		await transport.send(request);
		await vi.advanceTimersByTimeAsync(100);
		expect(gets).toBe(1);
		expect(messages).toEqual([{ jsonrpc: "2.0", method: "working" }]);
	} finally {
		await transport.close();
	}
});
