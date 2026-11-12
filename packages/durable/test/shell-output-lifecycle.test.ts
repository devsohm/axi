import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context, withAbortSignal } from "@axi/objects/context";
import { afterEach, expect, test, vi } from "vitest";
import { err, FileError, getOrThrow, ok } from "../src/env/index.ts";
import { NodeExecutionEnv } from "../src/env/node.ts";
import { runCommand } from "../src/env/node-shell.ts";

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});
async function fixture(shellEnv?: NodeJS.ProcessEnv) {
	const cwd = await mkdtemp(join(tmpdir(), "axi-shell-output-"));
	const env = new NodeExecutionEnv({ cwd, shellEnv });
	return {
		env,
		cwd,
		async [Symbol.asyncDispose]() {
			await env.cleanup(context);
			await rm(cwd, { recursive: true, force: true });
		},
	};
}

test.each([false, true])("inheritEnv=%s selects exactly which environment reaches the command", async (inheritEnv) => {
	vi.stubEnv("AXI_SHELL_PARENT", "parent");
	await using app = await fixture({ AXI_SHELL_HOST: "host", AXI_SHELL_OVERRIDE: "host" });
	let output = "";
	const result = await app.env.exec(
		[
			process.execPath,
			"-e",
			`process.stdout.write(JSON.stringify([
		process.env.AXI_SHELL_PARENT ?? null, process.env.AXI_SHELL_HOST ?? null,
		process.env.AXI_SHELL_OVERRIDE, process.env.AXI_SHELL_COMMAND
	]))`,
		],
		{
			inheritEnv,
			env: { AXI_SHELL_OVERRIDE: "command", AXI_SHELL_COMMAND: "only" },
			onOutput: (text) => {
				output += text;
			},
		},
		context,
	);
	expect(getOrThrow(result).exitCode).toBe(0);
	expect(JSON.parse(output)).toEqual([inheritEnv ? "parent" : null, inheritEnv ? "host" : null, "command", "only"]);
});

test("cancellation during working-directory resolution starts no process", async () => {
	await using app = await fixture();
	const controller = new AbortController();
	const host: Parameters<typeof runCommand>[0] = {
		cwd: () => app.cwd,
		processes: new Set(),
		resolve() {
			controller.abort();
			return app.cwd;
		},
		createTempFile: (options, call) => app.env.createTempFile(options, call),
	};
	expect(
		await runCommand(
			host,
			[process.execPath, "-e", 'throw new Error("must not start")'],
			{ cwd: "." },
			withAbortSignal(controller.signal, context),
		),
	).toMatchObject({ ok: false, error: { code: "aborted" } });
	expect(host.processes.size).toBe(0);
});

test("failed spill-file acquisition reports the storage failure and leaves the environment usable", async () => {
	await using app = await fixture();
	vi.spyOn(app.env, "createTempFile").mockResolvedValueOnce(err(new FileError("permission_denied", "spill denied")));
	const result = await app.env.exec(
		[process.execPath, "-e", 'process.stdout.write("output"); setInterval(() => {}, 1000)'],
		{
			spill: { afterBytes: 0, afterLines: 0 },
			timeout: 5,
		},
		context,
	);
	expect(result).toMatchObject({ ok: false, error: { code: "unknown", cause: { message: "spill denied" } } });
	expect(getOrThrow(await app.env.exec([process.execPath, "-e", ""], undefined, context)).exitCode).toBe(0);
});

test.each(["timeout", "aborted"] as const)(
	"%s retains the completed spill path and its partial output",
	async (reason) => {
		await using app = await fixture();
		const path = join(app.cwd, "partial.log");
		const controller = new AbortController(),
			retained = Promise.withResolvers<void>();
		vi.spyOn(app.env, "createTempFile").mockImplementationOnce(async () => {
			await writeFile(path, "");
			retained.resolve();
			return ok(path);
		});
		const pending = app.env.exec(
			[process.execPath, "-e", 'process.stdout.write("saved prefix\\n"); setInterval(() => {}, 1000)'],
			{
				spill: { afterBytes: 0, afterLines: 0 },
				timeout: reason === "timeout" ? 1 : 5,
			},
			withAbortSignal(controller.signal, context),
		);
		await retained.promise;
		await vi.waitFor(async () => {
			expect(await readFile(path, "utf8")).toBe("saved prefix\n");
		});
		if (reason === "aborted") controller.abort();
		expect(await pending).toMatchObject({ ok: false, error: { code: reason, spillPath: path } });
		expect(await readFile(path, "utf8")).toBe("saved prefix\n");
	},
);

test("process completion waits for delayed spill creation and writes the full queued output", async () => {
	await using app = await fixture();
	const path = join(app.cwd, "complete.log");
	const entered = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	vi.spyOn(app.env, "createTempFile").mockImplementationOnce(async () => {
		entered.resolve();
		await release.promise;
		await writeFile(path, "");
		return ok(path);
	});
	let finished = false;
	const pending = app.env
		.exec(
			[process.execPath, "-e", 'process.stdout.write("complete output\\n")'],
			{
				spill: { afterBytes: 0, afterLines: 0 },
				timeout: 5,
			},
			context,
		)
		.then((result) => {
			finished = true;
			return result;
		});
	try {
		await entered.promise;
		expect(finished).toBe(false);
		release.resolve();
		expect(getOrThrow(await pending)).toEqual({ exitCode: 0, spillPath: path });
		expect(await readFile(path, "utf8")).toBe("complete output\n");
	} finally {
		release.resolve();
		await pending;
	}
});
