import { expect, test, vi } from "vitest";
import { limitMcpContent, MCP_OUTPUT_MAX_BYTES, PipeTransport, type McpPipe } from "../src/index.ts";

test("closing before start prevents pipe creation and emits close once", async () => {
	const open = vi.fn(async (): Promise<never> => {
		throw new Error("pipe must not open");
	});
	const transport = new PipeTransport({ open });
	const closed = vi.fn();
	transport.onClose(closed);
	await expect(transport.send({ jsonrpc: "2.0", method: "notice" })).rejects.toMatchObject({
		name: "McpConnectionClosedError",
	});
	await transport.close();
	await transport.close();
	await expect(transport.start()).rejects.toMatchObject({ name: "McpConnectionClosedError" });
	expect(open).not.toHaveBeenCalled();
	expect(closed).toHaveBeenCalledTimes(1);
});

test("a pipe that opens after close is immediately released and its later exit failure is consumed", async () => {
	const pending = Promise.withResolvers<McpPipe>();
	const exit = Promise.withResolvers<void>();
	const close = vi.fn(() => exit.reject(new Error("late pipe failed")));
	const transport = new PipeTransport({ open: () => pending.promise });
	const closed = vi.fn();
	transport.onClose(closed);
	const starting = transport.start();
	const rejected = expect(starting).rejects.toMatchObject({ name: "McpConnectionClosedError" });
	await transport.close();
	pending.resolve({ write() {}, closeStdin() {}, close, exited: exit.promise });
	await rejected;
	expect(close).toHaveBeenCalledTimes(1);
	expect(closed).toHaveBeenCalledTimes(1);
});

test("pipe exit reports the failure, flushes a partial message and closes only once", async () => {
	const exit = Promise.withResolvers<void>();
	const failure = new Error("remote pipe lost");
	const transport = new PipeTransport({
		async open(handlers) {
			handlers.onStdout(Buffer.from('{"jsonrpc":"2.0","id":1'));
			return { write() {}, closeStdin() {}, close() {}, exited: exit.promise };
		},
	});
	const errors: Error[] = [],
		closed = vi.fn();
	transport.onError((error) => errors.push(error));
	transport.onClose(closed);
	await transport.start();
	await expect(transport.start()).rejects.toThrow(/already started/);
	exit.reject(failure);
	await vi.waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
	expect(errors[0]).toBe(failure);
	expect(errors[1]).toBeInstanceOf(Error);
	await expect(transport.send({ jsonrpc: "2.0", method: "notice" })).rejects.toMatchObject({
		name: "McpConnectionClosedError",
	});
	await transport.close();
	expect(closed).toHaveBeenCalledTimes(1);
});

test("close sends EOF first and terminates a pipe only after its grace period", async () => {
	vi.useFakeTimers();
	const exit = Promise.withResolvers<void>();
	const eof = vi.fn(),
		kill = vi.fn(() => exit.resolve());
	const transport = new PipeTransport({
		closeTimeoutMs: 25,
		async open() {
			return { write() {}, closeStdin: eof, close: kill, exited: exit.promise };
		},
	});
	try {
		await transport.start();
		const closing = transport.close();
		expect(eof).toHaveBeenCalledTimes(1);
		expect(kill).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(25);
		await closing;
		expect(kill).toHaveBeenCalledTimes(1);
		await transport.close();
		expect(eof).toHaveBeenCalledTimes(1);
	} finally {
		exit.resolve();
		await transport.close();
		vi.useRealTimers();
	}
});

test("a pipe that exits on EOF needs no forced termination or error notification", async () => {
	const exit = Promise.withResolvers<void>();
	const kill = vi.fn(),
		error = vi.fn();
	const transport = new PipeTransport({
		async open() {
			return { write() {}, closeStdin: () => exit.reject("closed by peer"), close: kill, exited: exit.promise };
		},
	});
	transport.onError(error);
	await transport.start();
	await transport.close();
	expect(kill).not.toHaveBeenCalled();
	expect(error).not.toHaveBeenCalled();
});

test("output size boundaries preserve small content and large UTF-8 output stays readable when saving fails", async () => {
	const image = { type: "image", data: "AQID", mimeType: "image/png" } as const;
	const small = [{ type: "text", text: "a".repeat(MCP_OUTPUT_MAX_BYTES) } as const, image];
	const saver = vi.fn(async () => "unused");
	expect((await limitMcpContent(small, saver)).content).toBe(small);
	expect(saver).not.toHaveBeenCalled();
	const text = "prefix\n" + "界🙂".repeat(5000) + "\nsuffix\n";
	for (const cause of [undefined, new Error("disk full"), "not writable"]) {
		const result = await limitMcpContent(
			[{ type: "text", text }, image],
			cause === undefined
				? undefined
				: async () => {
						throw cause;
					},
		);
		expect(result.fullOutputPath).toBeUndefined();
		expect(result.content[1]).toBe(image);
		const block = result.content[0];
		if (block?.type !== "text") throw new Error("Missing excerpt");
		expect(block.text).toContain("prefix\n");
		expect(block.text).toContain("\nsuffix\n");
		expect(block.text).not.toContain("�");
		if (cause !== undefined) expect(block.text).toContain(cause instanceof Error ? cause.message : cause);
	}
});
