import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { McpClient, PipeTransport } from "@axi/mcp";
import { expect, test } from "vitest";
import { Connection, localDaemon, openProcess } from "../src/index.ts";

test("an MCP client runs over the daemon's process pipes", async () => {
	const connection = new Connection({ command: [process.env.AXI_ENV_DAEMON ?? localDaemon()] });
	const client = new McpClient({ name: "process-client", version: "1" });
	const transport = new PipeTransport({
		open: (handlers) =>
			openProcess(connection, {
				cwd: tmpdir(),
				argv: [process.execPath, fileURLToPath(new URL("../../mcp/test/fixtures/server.cjs", import.meta.url))],
				env: { AXI_MCP_TEST: "process-server" },
				...handlers,
			}),
	});
	try {
		expect((await client.connect(transport)).serverInfo.name).toBe("process-server");
		expect((await client.listTools()).map((tool) => tool.name)).toEqual(["echo"]);
		expect(await client.callTool("echo", { text: "日本🙂" })).toEqual({ content: [{ type: "text", text: "日本🙂" }] });
	} finally {
		await client.close();
		connection.close();
	}
});

test("process pipes preserve binary input and separate output streams", async () => {
	const connection = new Connection({ command: [process.env.AXI_ENV_DAEMON ?? localDaemon()] });
	const stdout: Uint8Array[] = [],
		stderr: Uint8Array[] = [];
	try {
		const program = await openProcess(connection, {
			cwd: tmpdir(),
			argv: [
				process.execPath,
				"-e",
				"process.stderr.write('diagnostic'); process.stdin.pipe(process.stdout); process.stdin.on('end',()=>process.exitCode=4)",
			],
			onStdout: (bytes) => stdout.push(bytes),
			onStderr: (bytes) => stderr.push(bytes),
		});
		program.write(new Uint8Array([0, 255, 10, 13, 65]));
		program.closeStdin();
		expect(await program.exited).toBe(4);
		expect([...Buffer.concat(stdout)]).toEqual([0, 255, 10, 13, 65]);
		expect(Buffer.concat(stderr).toString()).toBe("diagnostic");
	} finally {
		connection.close();
	}
});

test("large process writes retain their order across frame boundaries", async () => {
	const connection = new Connection({ command: [process.env.AXI_ENV_DAEMON ?? localDaemon()] });
	const chunks: Uint8Array[] = [],
		input = Buffer.alloc(2500000, 113);
	try {
		const program = await openProcess(connection, {
			cwd: tmpdir(),
			argv: [
				process.execPath,
				"-e",
				"const h=require('node:crypto').createHash('sha256');process.stdin.on('data',b=>h.update(b));process.stdin.on('end',()=>process.stdout.write(h.digest('hex')))",
			],
			onStdout: (bytes) => chunks.push(bytes),
		});
		program.write("first");
		program.write(input);
		program.write("last");
		program.closeStdin();
		expect(await program.exited).toBe(0);
		expect(Buffer.concat(chunks).toString()).toBe(
			createHash("sha256").update("first").update(input).update("last").digest("hex"),
		);
	} finally {
		connection.close();
	}
});

test("process cancellation settles its exit and invalid starts fail before returning a handle", async () => {
	const connection = new Connection({ command: [process.env.AXI_ENV_DAEMON ?? localDaemon()] });
	try {
		await expect(openProcess(connection, { cwd: tmpdir(), argv: [], onStdout() {} })).rejects.toMatchObject({
			code: "EINVAL",
		});
		const program = await openProcess(connection, {
			cwd: tmpdir(),
			argv: [process.execPath, "-e", "setInterval(()=>{},1000)"],
			onStdout() {},
		});
		program.close();
		await expect(program.exited).rejects.toMatchObject({ code: "aborted" });
		program.write("ignored after exit");
		program.closeStdin();
		program.close();
	} finally {
		connection.close();
	}
});
