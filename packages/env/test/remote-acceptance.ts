import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { getOrThrow, type FileChange } from "@axi/durable/env";
import { BACKGROUND_CONTEXT as context } from "@axi/objects/context";
import { Connection, openProcess, openTerminal, RemoteExecutionEnv } from "../src/index.ts";

/** Run explicitly against a disposable remote machine. The caller owns its transport and credentials. */
export async function verifyRemoteEnvironment(connect: () => Promise<Connection>, shell: string) {
	let connection = await connect();
	let cwd: string | undefined;
	const passed: string[] = [];
	const content = Buffer.from("line one\n界🙂\n".repeat(100000));
	try {
		const info = await connection.info();
		const initial = new RemoteExecutionEnv({ connection, id: "acceptance", cwd: info.cwd, shellPath: shell });
		cwd = getOrThrow(await initial.createTempDir("axi-acceptance-", context));
		const env = new RemoteExecutionEnv({ connection, id: "acceptance", cwd, shellPath: shell });
		getOrThrow(await env.writeFile("data.bin", content, context));
		const read = getOrThrow(await env.readBinaryFile("data.bin", context));
		assert.equal(createHash("sha256").update(read).digest("hex"), createHash("sha256").update(content).digest("hex"));
		passed.push("large binary transfer");

		let output = "";
		const execution = getOrThrow(
			await env.exec(
				"printf 'héllo'",
				{
					onOutput: (text) => {
						output += text;
					},
				},
				context,
			),
		);
		assert.equal(execution.exitCode, 0);
		assert.equal(output, "héllo");
		passed.push("UTF-8 shell output");

		const stdout: Buffer[] = [],
			stderr: Buffer[] = [];
		const program = await openProcess(connection, {
			cwd,
			argv: [shell, "-c", "cat; printf diagnostic >&2"],
			onStdout: (bytes) => {
				stdout.push(Buffer.from(bytes));
			},
			onStderr: (bytes) => {
				stderr.push(Buffer.from(bytes));
			},
		});
		program.write(content);
		program.closeStdin();
		assert.equal(await program.exited, 0);
		assert.deepEqual(Buffer.concat(stdout), content);
		assert.equal(Buffer.concat(stderr).toString(), "diagnostic");
		passed.push("ordered process pipes");

		const cancelled = await env.exec("sleep 30", { timeout: 0.05 }, context);
		assert.ok(!cancelled.ok, "The timed command unexpectedly succeeded");
		assert.equal(cancelled.error.code, "timeout");
		passed.push("command timeout");

		const events: FileChange[] = [];
		const watcher = getOrThrow(
			await env.watch([{ path: cwd, recursive: true }], (event) => events.push(event), context),
		);
		try {
			getOrThrow(await env.writeFile("watched.txt", "ready", context));
			const deadline = Date.now() + 10000;
			while (
				!events.some((event) => event.kind === "paths" && event.paths.some((path) => path.endsWith("/watched.txt")))
			) {
				assert.ok(Date.now() < deadline, "The remote watcher delivered no matching event");
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
		} finally {
			await watcher.stop(context);
		}
		passed.push("filesystem watch");

		let terminalText = "";
		const terminal = await openTerminal(connection, {
			cwd,
			argv: [shell, "-c", "stty size; read line; printf 'ack:%s' \"$line\""],
			cols: 50,
			rows: 12,
			onData: (bytes) => {
				terminalText += Buffer.from(bytes).toString();
			},
		});
		terminal.write("terminal-ready\n");
		assert.equal(await terminal.exited, 0);
		assert.match(terminalText, /12 50/);
		assert.match(terminalText, /ack:terminal-ready/);
		passed.push("PTY input and dimensions");

		connection.close();
		connection = await connect();
		const reopened = new RemoteExecutionEnv({ connection, id: "reopened", cwd, shellPath: shell });
		assert.deepEqual(getOrThrow(await reopened.readBinaryFile("data.bin", context)), read);
		passed.push("new connection reads saved files");
		return { passed, bytes: content.length, remote: { os: info.os, arch: info.arch, version: info.version } };
	} finally {
		try {
			if (cwd !== undefined)
				getOrThrow(
					await new RemoteExecutionEnv({ connection, id: "cleanup", cwd }).remove(
						cwd,
						{ recursive: true, force: true },
						context,
					),
				);
		} finally {
			connection.close();
		}
	}
}

if (
	process.argv[1] &&
	existsSync(process.argv[1]) &&
	import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
	const command: unknown = JSON.parse(process.argv[2] ?? "null");
	const shell = process.argv[3];
	if (!Array.isArray(command) || command.length === 0 || !command.every((item) => typeof item === "string") || !shell)
		throw new Error("Usage: node remote-acceptance.ts '<JSON command array>' <remote shell path>");
	console.log(JSON.stringify(await verifyRemoteEnvironment(async () => new Connection({ command }), shell)));
}
