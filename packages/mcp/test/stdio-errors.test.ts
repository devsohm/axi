import { ChildProcess } from "node:child_process";
import { PassThrough, Writable } from "node:stream";
import { expect, test, vi } from "vitest";
import { StdioTransport } from "../src/transports/stdio.ts";

const { spawn, terminateTree } = vi.hoisted(() => ({ spawn: vi.fn(), terminateTree: vi.fn() }));
vi.mock("cross-spawn", () => ({ default: spawn }));
vi.mock("node:child_process", async (original) => ({
	...(await original<typeof import("node:child_process")>()),
	spawn: terminateTree,
}));

function peer(input: Writable, exitCode: number | null = null) {
	const child = Object.assign(new ChildProcess(), {
		exitCode,
		stdin: input,
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		kill: vi.fn(() => false),
	});
	spawn.mockImplementationOnce(() => {
		queueMicrotask(() => child.emit("spawn"));
		return child;
	});
	return child;
}

async function close(transport: StdioTransport, child: ChildProcess) {
	const closing = transport.close();
	child.emit("close", 0, null);
	await closing;
}

test("a failed pipe write rejects send with the original error and reports it to listeners", async () => {
	const failure = Object.assign(new Error("The peer stopped reading"), { code: "EPIPE" });
	const child = peer(
		new Writable({
			write(_chunk, _encoding, callback) {
				callback(failure);
			},
		}),
	);
	const transport = new StdioTransport({ command: "controlled-peer" });
	const errors: Error[] = [];
	transport.onError((error) => errors.push(error));
	try {
		await transport.start();
		await expect(transport.send({ jsonrpc: "2.0", method: "notice" })).rejects.toBe(failure);
		await vi.waitFor(() => expect(errors).toEqual([failure]));
	} finally {
		await close(transport, child);
	}
});

test("stdio events preserve messages and errors while shutdown suppresses child and input errors", async () => {
	const child = peer(
		new Writable({
			write(_chunk, _encoding, callback) {
				callback();
			},
		}),
	);
	const chunks: string[] = [],
		errors: Error[] = [],
		messages: unknown[] = [];
	const transport = new StdioTransport({ command: "controlled-peer", onStderr: (chunk) => chunks.push(chunk) });
	transport.onMessage((message) => messages.push(message));
	transport.onError((error) => errors.push(error));
	const failures = ["stdout", "stderr", "stdin", "process"].map((name) => new Error(name));
	try {
		await transport.start();
		child.stdout.write('{"jsonrpc":"2.0","method":"first"}\n');
		child.stdout.emit("data", '{"jsonrpc":"2.0","method":"second"}\n');
		child.stderr.write("one");
		child.stderr.emit("data", "two");
		child.stdout.emit("error", failures[0]);
		child.stderr.emit("error", failures[1]);
		child.stdin.emit("error", failures[2]);
		child.emit("error", failures[3]);
		expect(messages).toEqual([
			{ jsonrpc: "2.0", method: "first" },
			{ jsonrpc: "2.0", method: "second" },
		]);
		expect(chunks).toEqual(["one", "two"]);
		expect(transport.stderr).toBe("onetwo");
		expect(errors).toEqual(failures);
	} finally {
		await close(transport, child);
	}
	child.stdin.emit("error", new Error("input closed"));
	child.emit("error", new Error("child closed"));
	expect(errors).toEqual(failures);
	expect(transport.pid).toBeUndefined();
});

test.skipIf(process.platform !== "win32")(
	"closing an already-exited Windows peer sends EOF without terminating its tree",
	async () => {
		const child = peer(new PassThrough(), 0);
		const transport = new StdioTransport({ command: "controlled-peer" });
		const closed = vi.fn();
		transport.onClose(closed);
		terminateTree.mockClear();
		await transport.start();
		await transport.close();
		expect(child.stdin.writableEnded).toBe(true);
		expect(terminateTree).not.toHaveBeenCalled();
		child.emit("close", 0, null);
		expect(closed).toHaveBeenCalledTimes(1);
	},
);

test.skipIf(process.platform !== "win32")(
	"a failed Windows tree terminator does not prevent transport cleanup",
	async () => {
		const child = peer(new PassThrough());
		Object.assign(child, { pid: 12345 });
		const transport = new StdioTransport({ command: "controlled-peer" });
		const errors: Error[] = [];
		transport.onError((error) => errors.push(error));
		terminateTree.mockImplementationOnce(() => {
			const process = new ChildProcess();
			queueMicrotask(() => process.emit("error", new Error("taskkill unavailable")));
			return process;
		});
		await transport.start();
		await close(transport, child);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(terminateTree).toHaveBeenCalledWith("taskkill", ["/pid", "12345", "/T", "/F"], {
			stdio: "ignore",
			windowsHide: true,
		});
		expect(errors).toEqual([]);
	},
);
