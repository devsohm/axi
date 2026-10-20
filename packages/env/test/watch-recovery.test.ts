import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@axi/chord/context";
import { getOrThrow, type WatchChange } from "@axi/durable/env";
import { expect, test, vi } from "vitest";
import { Connection, localDaemon, RemoteExecutionEnv } from "../src/index.ts";

test.skipIf(process.platform === "win32")(
	"a remote watcher reconnects after daemon loss and requests a rescan before delivering new changes",
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "axi-watch-recovery-"));
		const connection = new Connection({ command: [localDaemon()] });
		const env = new RemoteExecutionEnv({
			connection,
			id: "watch-recovery",
			cwd: directory,
			watch: { mode: "polling", pollIntervalMs: 20 },
		});
		const changes: WatchChange[] = [];
		const watcher = getOrThrow(
			await env.watch(
				[{ path: ".", recursive: true }],
				(change) => {
					changes.push(change);
				},
				context,
			),
		);
		try {
			await writeFile(join(directory, "first.txt"), "first");
			await vi.waitFor(
				() =>
					expect(
						changes.some((change) => "paths" in change && change.paths.some((path) => path.endsWith("first.txt"))),
					).toBe(true),
				{ timeout: 3000 },
			);
			const daemon = await connection.info();
			process.kill(daemon.pid, "SIGKILL");
			await vi.waitFor(() => expect(changes.some((change) => "overflow" in change && change.overflow)).toBe(true), {
				timeout: 6000,
			});
			expect((await connection.info()).pid).not.toBe(daemon.pid);
			await writeFile(join(directory, "second.txt"), "second");
			await vi.waitFor(
				() =>
					expect(
						changes.some((change) => "paths" in change && change.paths.some((path) => path.endsWith("second.txt"))),
					).toBe(true),
				{ timeout: 3000 },
			);
			expect(changes.filter((change) => "error" in change)).toEqual([]);
			await watcher.close(context);
			const count = changes.length;
			await writeFile(join(directory, "closed.txt"), "closed");
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(changes.length).toBe(count);
		} finally {
			await watcher.close(context);
			await env.cleanup(context);
			connection.close();
			await rm(directory, { recursive: true, force: true });
		}
	},
	15000,
);
