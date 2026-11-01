import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@axi/objects/context";
import { expect, it } from "vitest";
import { Connection, localDaemon, RemoteExecutionEnv } from "../src/index.ts";

it.skipIf(process.platform === "win32").each(["close", "SIGTERM", "SIGHUP", "SIGINT"] as const)(
	"stops a command after its daemon receives %s",
	async (action) => {
		const connection = new Connection({ command: [process.env.AXI_ENV_DAEMON ?? localDaemon()] });
		const env = new RemoteExecutionEnv({ connection, id: "cleanup", cwd: tmpdir() });
		let commandPid: number | undefined;
		const alive = () => {
			if (commandPid === undefined) return false;
			try {
				process.kill(commandPid, 0);
				return true;
			} catch {
				return false;
			}
		};
		try {
			const daemon = await connection.info();
			const started = Promise.withResolvers<number>();
			const running = env.exec(
				["sh", "-c", "echo $$; exec sleep 30"],
				{
					onOutput: (text) => started.resolve(Number.parseInt(text, 10)),
				},
				BACKGROUND_CONTEXT,
			);
			commandPid = await started.promise;
			expect(commandPid).toBeGreaterThan(1);
			if (action === "close") connection.close();
			else process.kill(daemon.pid, action);
			expect((await running).ok).toBe(false);
			const deadline = Date.now() + 3000;
			while (alive() && Date.now() < deadline) await delay(25);
			expect(alive()).toBe(false);
		} finally {
			connection.close();
			if (commandPid !== undefined && commandPid > 1 && alive()) process.kill(commandPid, "SIGKILL");
		}
	},
	10000,
);
