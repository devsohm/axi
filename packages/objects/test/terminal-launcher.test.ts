import { createServer } from "node:http";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { act, attach, type PromptTerminal } from "../src/node/tui/actions.ts";
import { tokenOf } from "../src/node/tui/credentials.ts";
import { startTerminal, terminalFile } from "../src/node/tui/index.ts";
import { FrameReader, MAX_PIPE_FRAME } from "../src/node/tui/pipe.ts";
import { requireSandboxNode, Sandbox } from "../src/node/tui/sandbox.ts";
import type { SandboxMessage } from "../src/tui/bridge.ts";

function frame(header: object, body = Buffer.alloc(0)) {
	const json = Buffer.from(JSON.stringify(header)),
		prefix = Buffer.alloc(8);
	prefix.writeUInt32BE(4 + json.length + body.length);
	prefix.writeUInt32BE(json.length, 4);
	return Buffer.concat([prefix, json, body]);
}

it("decodes split sandbox frames without retaining mutable input bytes and refuses oversized messages", () => {
	const reader = new FrameReader(),
		encoded = Buffer.concat([
			frame({ kind: "write" }, Buffer.from("é")),
			frame({ kind: "request", id: 3, request: { kind: "open", url: "https://example.org" } }),
			frame({ kind: "socket_send", socket: 1 }, Buffer.from([4, 5])),
		]);
	const messages: SandboxMessage[] = [];
	for (const byte of encoded) messages.push(...reader.push(Buffer.from([byte])));
	encoded.fill(0);
	expect(messages).toEqual([
		{ kind: "write", data: "é" },
		{ kind: "request", id: 3, request: { kind: "open", url: "https://example.org" } },
		{ kind: "socket_send", socket: 1, bytes: new Uint8Array([4, 5]) },
	]);
	const size = Buffer.alloc(4);
	size.writeUInt32BE(MAX_PIPE_FRAME + 1);
	expect(() => new FrameReader().push(size)).toThrow("malformed frame");
	expect(() => new FrameReader().push(frame({ kind: "request", id: 1, request: { kind: "open", url: null } }))).toThrow(
		"malformed message",
	);
});

it("requires explicit consent before clipboard, browser and symlink attachment actions", async () => {
	const ask = vi.fn<PromptTerminal["ask"]>().mockResolvedValue(false),
		write = vi.fn(),
		opener = vi.fn(async () => {}),
		terminal: PromptTerminal = { columns: 60, ask, write };
	expect(await act({ kind: "copy", text: "safe text" }, terminal)).toBe(false);
	expect(write).not.toHaveBeenCalled();
	ask.mockResolvedValue(true);
	expect(await act({ kind: "copy", text: "safe text" }, terminal)).toBe(true);
	expect(write).toHaveBeenCalledWith(`\x1b]52;c;${Buffer.from("safe text").toString("base64")}\x07`);
	await expect(act({ kind: "copy", text: "hidden\x1b[31m" }, terminal)).rejects.toThrow("control characters");
	await expect(act({ kind: "open", url: "https://name:secret@example.org" }, terminal, opener)).rejects.toThrow(
		"without user info",
	);
	expect(await act({ kind: "open", url: "https://example.org/path" }, terminal, opener)).toBe(true);
	expect(opener).toHaveBeenCalledExactlyOnceWith("https://example.org/path");
	const dir = await mkdtemp(join(tmpdir(), "axi-attachment-"));
	try {
		const target = join(dir, "note.txt"),
			link = join(dir, "link.txt");
		await writeFile(target, "bytes");
		await symlink(target, link);
		ask.mockReset().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
		expect(await attach(link, terminal)).toBeNull();
		expect(ask).toHaveBeenCalledTimes(2);
		ask.mockResolvedValue(true);
		expect(await attach(target, terminal)).toEqual({ name: "note.txt", bytes: new TextEncoder().encode("bytes") });
		await expect(attach(join(dir, "a\tb"), terminal)).rejects.toThrow("cannot be attached");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

it("restricts terminal downloads to same-origin terminal assets and supports private credential files", async () => {
	const server = new URL("https://example.org/"),
		controller = new AbortController(),
		say = vi.fn();
	expect(terminalFile("/_objects/tui/plugin/a.js", server)).toBe("/_objects/tui/plugin/a.js");
	for (const path of [
		"https://other.example/_objects/tui/main",
		"/_objects/tui/../secret",
		"/_objects/tui/main?token=secret",
		"//other.example/main",
	])
		expect(() => terminalFile(path, server)).toThrow("no terminal file");
	expect(await tokenOf({ kind: "token", token: "direct" }, server, say, controller.signal)).toBe("direct");
	const dir = await mkdtemp(join(tmpdir(), "axi-credentials-"));
	try {
		const path = join(dir, "token");
		await writeFile(path, " file-token\n", { mode: 0o600 });
		expect(await tokenOf({ kind: "file", path }, server, say, controller.signal)).toBe("file-token");
		expect(await readFile(path, "utf8")).toBe(" file-token\n");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

it("requires the sandbox runtime and isolates process credentials while relaying input", async () => {
	expect(() => requireSandboxNode("26.5.0")).toThrow("26.5.1");
	expect(() => requireSandboxNode("26.5.1")).not.toThrow();
	try {
		requireSandboxNode();
	} catch {
		await expect(
			Sandbox.start(
				"",
				{ base: "test", combined: "", columns: 80, rows: 24, colors: "256", mode: "dark", locales: ["en"] },
				() => {},
				() => {},
			),
		).rejects.toThrow("26.5.1");
		return;
	}
	const messages: SandboxMessage[] = [],
		end = vi.fn(),
		sandbox = await Sandbox.start(
			`const bridge = globalThis.objectsBridge;
let blocked = false; try { require("node:fs"); } catch { blocked = true; }
bridge.send({kind:"write",data:JSON.stringify({env:Object.keys(process.env),blocked})});
bridge.onMessage(message=>{if(message.kind==="input")bridge.send({kind:"write",data:message.data});});`,
			{ base: "test", combined: "", columns: 80, rows: 24, colors: "256", mode: "dark", locales: ["en"] },
			(message) => messages.push(message),
			end,
		);
	try {
		await vi.waitFor(() =>
			expect(messages[0]).toEqual({ kind: "write", data: JSON.stringify({ env: [], blocked: true }) }),
		);
		sandbox.post({ kind: "input", data: "round trip" });
		await vi.waitFor(() => expect(messages.at(-1)).toEqual({ kind: "write", data: "round trip" }));
	} finally {
		await sandbox.terminate();
	}
	expect(end).not.toHaveBeenCalled();
});

it("restores terminal modes and removes listeners when a running launcher exits", async () => {
	try {
		requireSandboxNode();
	} catch {
		await expect(
			startTerminal({ url: "http://127.0.0.1/", credentials: { kind: "token", token: "unused" } }),
		).rejects.toThrow("26.5.1");
		return;
	}
	const source =
			'const bridge=globalThis.objectsBridge;bridge.send({kind:"write",data:"ready"});bridge.onMessage(()=>{});',
		authorized: string[] = [];
	const server = createServer((request, response) => {
		authorized.push(request.headers.authorization ?? "");
		if (request.url === "/_objects/tui/start")
			response.end(
				JSON.stringify({ base: "test", script: "/_objects/tui/script", combined: "/_objects/tui/combined" }),
			);
		else response.end(request.url === "/_objects/tui/script" ? source : "");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("missing test listener");
	const input = new PassThrough(),
		output = new PassThrough();
	let painted = "";
	output.on("data", (chunk) => {
		painted += chunk.toString();
	});
	const listeners = process.listenerCount("exit");
	try {
		const running = await startTerminal({
			url: `http://127.0.0.1:${address.port}/`,
			credentials: { kind: "token", token: "test-only" },
			input,
			output,
		});
		try {
			await vi.waitFor(() => expect(painted).toContain("ready"));
			input.write("\x03\x03\x03");
			expect(await running.exited).toBe(130);
			expect(painted).toContain("\x1b[?1049l");
			expect(input.listenerCount("data")).toBe(0);
			expect(process.listenerCount("exit")).toBe(listeners);
			expect(authorized).toEqual(["Bearer test-only", "Bearer test-only", "Bearer test-only"]);
		} finally {
			await running.stop();
		}
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		input.destroy();
		output.destroy();
	}
});
