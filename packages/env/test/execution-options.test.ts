import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context, withAbortSignal } from "@axi/objects/context";
import { expect, test, vi } from "vitest";
import { Connection, localDaemon, RemoteExecutionEnv } from "../src/index.ts";

test.skipIf(process.platform === "win32")(
	"shell and request environment settings retain their documented priority",
	async () => {
		const connection = new Connection({ command: [localDaemon()] });
		const env = new RemoteExecutionEnv({
			connection,
			id: "shell-options",
			cwd: tmpdir(),
			shellPath: "/bin/sh",
			shellEnv: { AXI_BASE: "inherited", AXI_CHOICE: "shell" },
		});
		try {
			const inherited: string[] = [];
			expect(
				await env.exec(
					'printf "%s|%s" "$AXI_BASE" "$AXI_CHOICE"',
					{
						env: { AXI_CHOICE: "request" },
						onOutput: (text) => inherited.push(text),
					},
					context,
				),
			).toMatchObject({ ok: true, value: { exitCode: 0 } });
			expect(inherited.join("")).toBe("inherited|request");
			const isolated: string[] = [];
			expect(
				await env.exec(
					[
						process.execPath,
						"-e",
						"process.stdout.write(JSON.stringify([process.env.AXI_BASE ?? null,process.env.AXI_CHOICE]))",
					],
					{
						inheritEnv: false,
						env: { AXI_CHOICE: "isolated" },
						onOutput: (text) => isolated.push(text),
					},
					context,
				),
			).toMatchObject({ ok: true, value: { exitCode: 0 } });
			expect(JSON.parse(isolated.join(""))).toEqual([null, "isolated"]);
		} finally {
			connection.close();
		}
	},
);

test("cancelling working-directory resolution does not cancel shared daemon startup", async () => {
	const entered = Promise.withResolvers<void>();
	const launch = Promise.withResolvers<readonly string[]>();
	const peer = [process.execPath, fileURLToPath(new URL("./fixtures/peer.ts", import.meta.url))];
	const connection = new Connection({
		command: () => {
			entered.resolve();
			return launch.promise;
		},
	});
	const env = new RemoteExecutionEnv({ connection, id: "cancel-cwd", cwd: "/project" });
	const controller = new AbortController();
	try {
		const pending = env.exec("must not run", { cwd: "nested" }, withAbortSignal(controller.signal, context));
		await entered.promise;
		controller.abort();
		expect(await pending).toMatchObject({ ok: false, error: { code: "aborted" } });
		launch.resolve(peer);
		expect((await connection.request("echo", { value: "ready" })).json.value).toBe("ready");
	} finally {
		launch.resolve(peer);
		connection.close();
	}
});

test.each([new Error("Transport unavailable"), "Transport unavailable"])(
	"execution converts a transport rejection %j and permits a later command",
	async (failure) => {
		const connection = new Connection({ command: [localDaemon()] });
		const env = new RemoteExecutionEnv({ connection, id: "request-failure", cwd: tmpdir() });
		const request = vi.spyOn(connection, "request").mockRejectedValueOnce(failure);
		try {
			expect(await env.exec([process.execPath, "-e", "process.exit(0)"], undefined, context)).toMatchObject({
				ok: false,
				error: { code: "unknown", message: "Transport unavailable" },
			});
			request.mockRestore();
			expect(await env.exec([process.execPath, "-e", "process.exit(0)"], undefined, context)).toMatchObject({
				ok: true,
				value: { exitCode: 0 },
			});
		} finally {
			request.mockRestore();
			connection.close();
		}
	},
);

test("a callback failure takes priority even when the program completes immediately", async () => {
	const connection = new Connection({ command: [localDaemon()] });
	const env = new RemoteExecutionEnv({ connection, id: "completed-output", cwd: tmpdir() });
	let callbacks = 0;
	try {
		const result = await env.exec(
			[process.execPath, "-e", "process.stdout.write('ready')"],
			{
				onOutput() {
					callbacks++;
					throw "Cannot consume output";
				},
			},
			context,
		);
		expect(result).toMatchObject({
			ok: false,
			error: { code: "callback_error", message: "Cannot consume output", cause: new Error("Cannot consume output") },
		});
		expect(callbacks).toBe(1);
		expect(await env.exec([process.execPath, "-e", "process.exit(0)"], undefined, context)).toMatchObject({
			ok: true,
			value: { exitCode: 0 },
		});
	} finally {
		connection.close();
	}
});
