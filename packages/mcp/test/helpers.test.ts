import { spawn } from "node:child_process";
import { expect, test } from "vitest";
import {
	createMcpToolName,
	isMcpServerOverride,
	limitMcpContent,
	mcpNamespace,
	normalizeMcpInputSchema,
	PipeTransport,
	validateMcpServerConfig,
	type JsonRpcMessage,
} from "../src/index.ts";

test("model tool names are deterministic identifiers with collision and length handling", () => {
	const ordinary = createMcpToolName("my-server", "run file");
	expect(ordinary).toBe("mcp__my_server__run_file");
	expect(mcpNamespace("my-server")).toBe("mcp__my_server");
	const collision = createMcpToolName("my-server", "run file", (name) => name === ordinary);
	expect(collision).not.toBe(ordinary);
	expect(collision).toMatch(/^mcp__my_server__run_file_[a-f0-9]{8}$/);
	expect(createMcpToolName("a".repeat(100), "b")).toHaveLength(64);
});

test("configuration validation selects a transport and preserves application fields", () => {
	const raw = {
		url: "http://localhost:8000/mcp",
		application: true,
		oauth: { callbackUrl: "http://localhost:7000/cb", callbackPort: 7000 },
	};
	const result = validateMcpServerConfig("docs", raw);
	expect(result).toEqual({ kind: "http", config: raw });
	if (result.kind === "http") expect(result.config).toBe(raw);
	for (const value of [{ command: "x", args: [7] }, { url: "file:///local" }, { command: "x", enabled: 1 }])
		expect(validateMcpServerConfig("test", value).kind).toBe("invalid");
	expect(isMcpServerOverride({ enabled: false })).toBe(true);
	expect(isMcpServerOverride({ command: "x" })).toBe(false);
	expect(
		isMcpServerOverride({
			command: "x",
			get url(): never {
				throw new Error("Unused URL");
			},
		}),
	).toBe(false);
	expect(
		isMcpServerOverride({
			url: "https://example.test/mcp",
			get type(): never {
				throw new Error("Unused transport");
			},
		}),
	).toBe(false);
	expect(normalizeMcpInputSchema({ required: ["path"] })).toEqual({
		type: "object",
		properties: {},
		required: ["path"],
	});
});

test("large model output keeps both ends and images and saves the entire original text", async () => {
	const text = "first\n" + "🙂".repeat(15000) + "\nlast";
	let saved: string | Uint8Array | undefined;
	const image = { type: "image", data: "AAAA", mimeType: "image/png" } as const;
	const result = await limitMcpContent([{ type: "text", text }, image], async (data, extension) => {
		saved = data;
		expect(extension).toBe(".txt");
		return "/output/full.txt";
	});
	expect(saved).toBe(text);
	expect(result.fullOutputPath).toBe("/output/full.txt");
	expect(result.content[1]).toBe(image);
	const first = result.content[0];
	if (first?.type !== "text") throw new Error("Missing output text");
	expect(first.text).toContain("first\n");
	expect(first.text).toContain("\nlast");
	expect(first.text).not.toContain("\uFFFD");
	expect(Buffer.byteLength(first.text)).toBeLessThan(22000);
});

test("pipe transport captures framing options once at construction", () => {
	let reads = 0;
	const transport = new PipeTransport({
		async open() {
			throw new Error("No process should start");
		},
		get maxMessageBytes() {
			if (++reads > 1) throw new Error("Framing options were read again");
			return 64;
		},
	});
	expect(transport.options.maxMessageBytes).toBe(64);
	expect(reads).toBe(1);
});

test("stderr callbacks receive framing options without process controls", async () => {
	let receiver: unknown;
	const chunks: string[] = [];
	const transport = new PipeTransport({
		maxMessageBytes: 64,
		maxStderrBytes: 8,
		closeTimeoutMs: 10,
		async open(handlers) {
			handlers.onStderr(new TextEncoder().encode("diagnostic"));
			return { write() {}, closeStdin() {}, close() {}, exited: Promise.resolve() };
		},
		onStderr(this: unknown, chunk) {
			receiver = this;
			chunks.push(chunk);
		},
	});
	await transport.start();
	await transport.close();
	expect(chunks).toEqual(["diagnostic"]);
	expect(transport.stderr).toBe("agnostic");
	expect(receiver).toEqual({
		maxMessageBytes: 64,
		maxStderrBytes: 8,
		onMessage: expect.any(Function),
		onError: expect.any(Function),
		onStderr: expect.any(Function),
	});
});

test("pipe transport exchanges framed messages with a real child and closes its input", async () => {
	const messages: JsonRpcMessage[] = [];
	const transport = new PipeTransport({
		open: async (handlers) => {
			const child = spawn(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], { stdio: "pipe" });
			child.stdout.on("data", handlers.onStdout);
			child.stderr.on("data", handlers.onStderr);
			const exited = new Promise<void>((resolve, reject) => {
				child.once("close", () => resolve());
				child.once("error", reject);
			});
			return {
				write: (data) => {
					child.stdin.write(data);
				},
				closeStdin: () => {
					child.stdin.end();
				},
				close: () => {
					child.kill();
				},
				exited,
			};
		},
	});
	transport.onMessage((message) => messages.push(message));
	await transport.start();
	try {
		await transport.send({ jsonrpc: "2.0", id: 7, method: "ping" });
		await expect.poll(() => messages).toEqual([{ jsonrpc: "2.0", id: 7, method: "ping" }]);
	} finally {
		await transport.close();
	}
	await expect(transport.send({ jsonrpc: "2.0", id: 8, method: "ping" })).rejects.toThrow();
});
