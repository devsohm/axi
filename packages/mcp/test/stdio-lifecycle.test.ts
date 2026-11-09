import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test, vi } from "vitest";
import { StdioTransport, type JsonRpcMessage } from "../src/index.ts";

function child(script: string, extra: Partial<ConstructorParameters<typeof StdioTransport>[0]> = {}) {
	return new StdioTransport({ command: process.execPath, args: ["-e", script], closeTimeoutMs: 50, ...extra });
}

test("closing an unstarted stdio transport prevents spawning and emits close once", async () => {
	const transport = child("throw new Error('Must not spawn')");
	const closed = vi.fn();
	transport.onClose(closed);
	await expect(transport.send({ jsonrpc: "2.0", method: "notice" })).rejects.toMatchObject({
		name: "McpConnectionClosedError",
	});
	await transport.close();
	await transport.close();
	await expect(transport.start()).rejects.toMatchObject({ name: "McpConnectionClosedError" });
	expect(transport.pid).toBeUndefined();
	expect(closed).toHaveBeenCalledTimes(1);
});

test("a failed spawn rejects startup and releases the transport", async () => {
	const transport = new StdioTransport({ command: join(tmpdir(), "axi-mcp-no-command", "missing-executable") });
	const closed = vi.fn();
	transport.onClose(closed);
	try {
		await expect(transport.start()).rejects.toMatchObject({ code: "ENOENT" });
		await vi.waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
		expect(transport.pid).toBeUndefined();
		await expect(transport.send({ jsonrpc: "2.0", method: "notice" })).rejects.toMatchObject({
			name: "McpConnectionClosedError",
		});
	} finally {
		await transport.close();
	}
	expect(closed).toHaveBeenCalledTimes(1);
});

test("a child exiting with an incomplete frame reports the frame error and closes", async () => {
	const transport = child('process.stdout.write(\'{"jsonrpc":"2.0","id":1\');');
	const errors: Error[] = [];
	const messages: JsonRpcMessage[] = [];
	const closed = vi.fn();
	transport.onError((error) => errors.push(error));
	transport.onMessage((message) => messages.push(message));
	transport.onClose(closed);
	try {
		await transport.start();
		await vi.waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
		expect(errors).toHaveLength(1);
		expect(errors[0]?.message).toMatch(/JSON|message/i);
		expect(messages).toEqual([]);
	} finally {
		await transport.close();
	}
	expect(closed).toHaveBeenCalledTimes(1);
});

test("a second start is refused while the original child continues to receive EOF", async () => {
	const transport = child('process.stdin.resume(); process.stdin.on("end", () => process.exit(0));');
	const closed = vi.fn();
	transport.onClose(closed);
	try {
		await transport.start();
		expect(transport.pid).toBeGreaterThan(0);
		await expect(transport.start()).rejects.toThrow("already started");
		await transport.close();
		expect(transport.pid).toBeUndefined();
		expect(closed).toHaveBeenCalledTimes(1);
	} finally {
		await transport.close();
	}
});

test("close terminates a child that keeps running after EOF and ignores SIGTERM", async () => {
	const transport = child(`
		process.on("SIGTERM", () => {});
		process.stdin.resume();
		setInterval(() => {}, 1000);
		process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "ready" }) + "\\n");
	`);
	const ready = Promise.withResolvers<void>();
	transport.onMessage(() => ready.resolve());
	try {
		await transport.start();
		await ready.promise;
		const pid = transport.pid;
		if (pid === undefined) throw new Error("The test child did not start");
		await transport.close();
		expect(transport.pid).toBeUndefined();
		expect(() => process.kill(pid, 0)).toThrow();
	} finally {
		await transport.close();
	}
});

test("isolated child environments reach stderr callbacks while the retained tail remains bounded", async () => {
	const transport = child("process.stderr.write(process.env.AXI_MCP_VALUE); process.stdin.resume();", {
		inheritEnv: false,
		env: { AXI_MCP_VALUE: "prefix-tail" },
		maxStderrBytes: 4,
		onStderr: (text) => received.push(text),
	});
	const received: string[] = [];
	try {
		await transport.start();
		await vi.waitFor(() => expect(received.join("")).toBe("prefix-tail"));
		expect(transport.stderr).toBe("tail");
	} finally {
		await transport.close();
	}
});
