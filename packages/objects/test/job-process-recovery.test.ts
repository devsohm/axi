import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { awaitWithContext, BACKGROUND_CONTEXT as context, withAbortSignal } from "../src/context/index.ts";
import { type JobOutcome, openCheckpointJob } from "./fixtures/checkpoint-job.ts";

test.each(["rerun", "abandon"] as const)(
	"a killed persisted job follows %s and keeps its committed state and identity",
	async (policy) => {
		const directory = await mkdtemp(join(tmpdir(), "axi-job-recovery-"));
		const path = join(directory, "store.sqlite");
		const child = fork(fileURLToPath(new URL("./fixtures/checkpoint-job.ts", import.meta.url)), [path, policy], {
			execArgv: [],
			stdio: ["ignore", "ignore", "pipe", "ipc"],
		});
		const exited = once(child, "exit");
		const finishing = Promise.withResolvers<JobOutcome>(),
			release = Promise.withResolvers<void>();
		let fixture: Awaited<ReturnType<typeof openCheckpointJob>> | undefined;
		let diagnostic = "";
		child.stderr?.on("data", (chunk: Buffer) => {
			diagnostic = (diagnostic + chunk.toString()).slice(-4000);
		});
		try {
			const ready: unknown = await Promise.race([
				once(child, "message", { signal: AbortSignal.timeout(8000) }).then(([message]: unknown[]) => message),
				exited.then(() => {
					throw new Error(`Checkpoint fixture exited before readiness: ${diagnostic}`);
				}),
			]);
			if (
				!ready ||
				typeof ready !== "object" ||
				!("kind" in ready) ||
				ready.kind !== "ready" ||
				!("id" in ready) ||
				typeof ready.id !== "string"
			)
				throw new Error("Invalid checkpoint fixture readiness");
			expect(child.kill("SIGKILL")).toBe(true);
			const [, signal] = await exited;
			if (process.platform !== "win32") expect(signal).toBe("SIGKILL");
			let invocations = 0,
				finishes = 0;
			fixture = await openCheckpointJob(
				path,
				policy,
				async (args, ctx) => {
					invocations++;
					expect(args).toBe("archive");
					return ctx.state.value.completed;
				},
				async (outcome) => {
					finishes++;
					finishing.resolve(outcome);
					await release.promise;
				},
			);
			const bounded = withAbortSignal(AbortSignal.timeout(8000), context);
			const staged = await awaitWithContext(finishing.promise, bounded);
			const expected = {
				id: ready.id,
				args: "archive",
				state: { completed: 41 },
				...(policy === "rerun"
					? { kind: "done", result: 41 }
					: { kind: "failed", error: { kind: "aborted", reason: "restart" } }),
			};
			expect(staged).toEqual(expected);
			const settled = fixture.jobs.outcome(ready.id, bounded);
			release.resolve();
			expect(await settled).toEqual(expected);
			expect(fixture.jobs.running.value).toEqual([]);
			expect({ invocations, finishes, errors: fixture.errors }).toEqual({
				invocations: policy === "rerun" ? 1 : 0,
				finishes: 1,
				errors: [],
			});
		} finally {
			release.resolve();
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			await exited;
			await fixture?.host.close(context);
			await fixture?.store.close(context);
			await rm(directory, { recursive: true, force: true });
		}
	},
	20_000,
);
