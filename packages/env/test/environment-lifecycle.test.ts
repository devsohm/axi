import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@axi/objects/context";
import { getOrThrow } from "@axi/durable/env";
import { afterEach, expect, test, vi } from "vitest";
import { Connection, localDaemon, RemoteExecutionEnv } from "../src/index.ts";

afterEach(() => vi.unstubAllEnvs());
async function fixture(shellEnv?: Record<string, string>) {
	const cwd = await mkdtemp(join(tmpdir(), "axi-env-lifecycle-"));
	const connection = new Connection({ command: [localDaemon()] });
	const env = new RemoteExecutionEnv({
		connection,
		cwd,
		id: "lifecycle",
		shellEnv,
		watch: { mode: "polling", pollIntervalMs: 20 },
	});
	return {
		connection,
		env,
		async [Symbol.asyncDispose]() {
			await env.cleanup(context);
			connection.close();
			await rm(cwd, { recursive: true, force: true });
		},
	};
}

test("an already-aborted watch starts no daemon", async () => {
	let starts = 0;
	const connection = new Connection({
		command: async () => {
			starts++;
			return [localDaemon()];
		},
	});
	try {
		const env = new RemoteExecutionEnv({ connection, cwd: tmpdir(), id: "cancelled-watch" });
		expect(await env.watch([{ path: "." }], () => {}, { ...context, abortSignal: AbortSignal.abort() })).toMatchObject({
			ok: false,
			error: { code: "aborted" },
		});
		expect(starts).toBe(0);
	} finally {
		connection.close();
	}
});

test.each(["watch", "exec"] as const)(
	"cancellation during %s path resolution prevents operation dispatch",
	async (operation) => {
		await using app = await fixture();
		const controller = new AbortController();
		const info = app.connection.info.bind(app.connection),
			request = app.connection.request.bind(app.connection);
		let dispatched = 0;
		app.connection.info = async (signal) => {
			const value = await info(signal);
			controller.abort();
			return value;
		};
		app.connection.request = (...args) => {
			if (args[0] === operation) dispatched++;
			return request(...args);
		};
		try {
			const call = { ...context, abortSignal: controller.signal };
			const result =
				operation === "watch"
					? await app.env.watch([{ path: "." }], () => {}, call)
					: await app.env.exec([process.execPath, "-e", "throw new Error('Must not execute')"], { cwd: "." }, call);
			expect(result).toMatchObject({ ok: false, error: { code: "aborted" } });
			expect(dispatched).toBe(0);
		} finally {
			app.connection.info = info;
			app.connection.request = request;
		}
	},
);

test("cancellation as a watch becomes ready releases it and permits another watch", async () => {
	await using app = await fixture();
	const request = app.connection.request.bind(app.connection),
		controller = new AbortController();
	let watchSignal: AbortSignal | undefined;
	app.connection.request = (op, fields, options) => {
		if (op !== "watch") return request(op, fields, options);
		watchSignal = options?.signal;
		return request(op, fields, {
			...options,
			onEvent(event, payload) {
				options?.onEvent?.(event, payload);
				if (event.kind === "ready") controller.abort();
			},
		});
	};
	try {
		expect(
			await app.env.watch([{ path: "." }], () => {}, { ...context, abortSignal: controller.signal }),
		).toMatchObject({ ok: false, error: { code: "aborted" } });
		expect(watchSignal?.aborted).toBe(true);
		app.connection.request = request;
		const next = getOrThrow(await app.env.watch([{ path: "." }], () => {}, context));
		await next.stop(context);
	} finally {
		app.connection.request = request;
	}
});

test.each(["output consumer failed", 42])(
	"a callback throwing %j cancels its command and exposes an Error cause",
	async (cause) => {
		await using app = await fixture();
		const result = await app.env.exec(
			[process.execPath, "-e", "process.stdout.write('ready'); setTimeout(() => {}, 10000)"],
			{
				onOutput() {
					throw cause;
				},
			},
			context,
		);
		expect(result).toMatchObject({
			ok: false,
			error: { code: "callback_error", message: String(cause), cause: expect.any(Error) },
		});
		const output: string[] = [];
		expect(
			getOrThrow(
				await app.env.exec(
					[process.execPath, "-e", "process.stdout.write('recovered')"],
					{ onOutput: (text) => output.push(text) },
					context,
				),
			).exitCode,
		).toBe(0);
		expect(output.join("")).toBe("recovered");
	},
);

test.each([false, true])(
	"execution environment inheritance and per-call overrides are honored: %s",
	async (inheritEnv) => {
		vi.stubEnv("AXI_ENV_FIXTURE_HOST", "host");
		await using app = await fixture({
			AXI_ENV_FIXTURE_CONSTRUCTOR: "constructor",
			AXI_ENV_FIXTURE_OVERRIDE: "constructor",
		});
		const output: string[] = [];
		getOrThrow(
			await app.env.exec(
				[
					process.execPath,
					"-e",
					`process.stdout.write(JSON.stringify({
		host: process.env.AXI_ENV_FIXTURE_HOST ?? null,
		constructor: process.env.AXI_ENV_FIXTURE_CONSTRUCTOR ?? null,
		override: process.env.AXI_ENV_FIXTURE_OVERRIDE ?? null,
		only: process.env.AXI_ENV_FIXTURE_ONLY ?? null
	}))`,
				],
				{
					inheritEnv,
					env: { AXI_ENV_FIXTURE_OVERRIDE: "call", AXI_ENV_FIXTURE_ONLY: "only" },
					onOutput: (text) => output.push(text),
				},
				context,
			),
		);
		const values: unknown = JSON.parse(output.join(""));
		expect(values).toEqual({
			host: inheritEnv ? "host" : null,
			constructor: inheritEnv ? "constructor" : null,
			override: "call",
			only: "only",
		});
	},
);
