import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@axi/objects/context";
import { expect, it } from "vitest";
import { Connection } from "../src/connection.ts";
import { RemoteExecutionEnv } from "../src/remote-env.ts";

const peer = [process.execPath, fileURLToPath(new URL("./fixtures/peer.ts", import.meta.url))];

it.each(["request", "info", "file"] as const)("cancels %s while shared startup is pending", async (operation) => {
	const launch = Promise.withResolvers<readonly string[]>();
	const connection = new Connection({ command: () => launch.promise });
	const controller = new AbortController();
	let deadline: ReturnType<typeof setTimeout> | undefined;
	try {
		const context = withAbortSignal(controller.signal, BACKGROUND_CONTEXT);
		const pending =
			operation === "request"
				? connection.request("echo", {}, { signal: controller.signal })
				: operation === "info"
					? connection.info(controller.signal)
					: new RemoteExecutionEnv({ connection, id: "offline", cwd: "/" })
							.readTextFile("/file", context)
							.then((result) => {
								if (!result.ok) throw result.error;
								return result.value;
							});
		controller.abort();
		await expect(
			Promise.race([
				pending,
				new Promise((_, reject) => {
					deadline = setTimeout(() => reject(new Error("Still waiting for startup")), 300);
				}),
			]),
		).rejects.toMatchObject({ code: "aborted" });
		launch.resolve(peer);
		expect((await connection.request("echo", { value: "connected" })).json.value).toBe("connected");
	} finally {
		clearTimeout(deadline);
		launch.resolve(peer);
		connection.close();
	}
});

it("finishes an unanswered cancellation after the daemon grace period", async () => {
	const connection = new Connection({ command: [...peer, "--silent"] });
	try {
		await connection.info();
		const controller = new AbortController();
		const started = performance.now();
		await expect(
			connection.request(
				"hold",
				{},
				{
					signal: controller.signal,
					onStart: () => queueMicrotask(() => controller.abort()),
				},
			),
		).rejects.toMatchObject({ code: "aborted" });
		expect(performance.now() - started).toBeGreaterThanOrEqual(900);
		expect(performance.now() - started).toBeLessThan(2500);
	} finally {
		connection.close();
	}
}, 3000);

it.each([false, true])(
	"enforces an exec timeout locally when the daemon is ready: %s",
	async (ready) => {
		const launch = Promise.withResolvers<readonly string[]>();
		const connection = new Connection({ command: ready ? [...peer, "--silent"] : () => launch.promise });
		try {
			if (ready) await connection.info();
			const environment = new RemoteExecutionEnv({ connection, id: "offline", cwd: "/" });
			const started = performance.now();
			const result = await environment.exec("unused", { timeout: 0.05 }, BACKGROUND_CONTEXT);
			expect(result).toMatchObject({ ok: false, error: { code: "timeout", message: "timeout:0.05" } });
			expect(performance.now() - started).toBeLessThan(2500);
		} finally {
			launch.resolve(peer);
			connection.close();
		}
	},
	3000,
);
