import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@axi/objects/context";
import { getOrThrow } from "@axi/durable/env";
import { expect, test } from "vitest";
import { Connection, localDaemon, RemoteExecutionEnv } from "../src/index.ts";

test("temporary remote files preserve requested names and are independently writable", async () => {
	const connection = new Connection({ command: [localDaemon()] });
	const env = new RemoteExecutionEnv({ connection, id: "temporary-files", cwd: tmpdir() });
	const paths: string[] = [];
	try {
		for (const options of [undefined, { prefix: "axi-", suffix: ".log" }]) {
			const path = getOrThrow(await env.createTempFile(options, context));
			paths.push(dirname(path));
			expect(basename(path)).toMatch(options ? /^axi-.+\.log$/ : /^[\da-f-]+$/);
			expect((await stat(path)).size).toBe(0);
			getOrThrow(await env.writeFile(path, "saved", context));
			expect(await readFile(path, "utf8")).toBe("saved");
		}
		const dir = getOrThrow(await env.createTempDir(undefined, context));
		paths.push(dir);
		expect(basename(dir)).toMatch(/^tmp-/);
		expect((await stat(dir)).isDirectory()).toBe(true);
		expect(await env.createTempFile(undefined, { ...context, abortSignal: AbortSignal.abort() })).toMatchObject({
			ok: false,
			error: { code: "aborted" },
		});
	} finally {
		connection.close();
		for (const path of paths) await rm(path, { recursive: true, force: true });
	}
});

test("a temporary-file write failure reports its resolved path and leaves the connection usable", async () => {
	const connection = new Connection({ command: [localDaemon()] });
	const env = new RemoteExecutionEnv({ connection, id: "temporary-file-failure", cwd: tmpdir() });
	const paths: string[] = [];
	try {
		const failed = await env.createTempFile({ prefix: "missing/", suffix: ".log" }, context);
		expect(failed.ok).toBe(false);
		if (failed.ok) throw new Error("Expected the missing parent to reject the write");
		if (failed.error.path === undefined) throw new Error("Missing resolved failure path");
		expect(failed.error.code).toBe("not_found");
		expect(basename(dirname(failed.error.path))).toBe("missing");
		expect(basename(failed.error.path)).toMatch(/^[\da-f-]+\.log$/);
		paths.push(dirname(dirname(failed.error.path)));
		const path = getOrThrow(await env.createTempFile(undefined, context));
		paths.push(dirname(path));
		getOrThrow(await env.writeFile(path, "still connected", context));
		expect(await readFile(path, "utf8")).toBe("still connected");
	} finally {
		connection.close();
		for (const path of paths) await rm(path, { recursive: true, force: true });
	}
});

test("remote directory listings retain metadata and apply POSIX byte ordering", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "axi-directory-order-"));
	const connection = new Connection({ command: [localDaemon()] }),
		env = new RemoteExecutionEnv({ connection, id: "directories", cwd });
	try {
		for (const name of ["界", "é", "beta", "Alpha", "apple"]) await writeFile(join(cwd, name), name);
		getOrThrow(await env.createDir("directory", undefined, context));
		const entries = getOrThrow(await env.listDir(".", context));
		const names = entries.map((entry) => entry.name),
			expected = ["Alpha", "apple", "beta", "directory", "é", "界"];
		if (process.platform === "win32") expect(new Set(names)).toEqual(new Set(expected));
		else expect(names).toEqual(expected);
		for (const entry of entries) {
			expect(entry.path).toBe(join(cwd, entry.name));
			expect(entry.kind).toBe(entry.name === "directory" ? "directory" : "file");
			expect(entry.mtimeMs).toBeGreaterThan(0);
			if (entry.kind === "file") expect(entry.size).toBe(Buffer.byteLength(entry.name));
		}
		expect(await env.listDir("absent", context)).toMatchObject({ ok: false, error: { code: "not_found" } });
	} finally {
		connection.close();
		await rm(cwd, { recursive: true, force: true });
	}
});

test("large writes and UTF-8 reads preserve content across every transfer boundary", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "axi-large-text-"));
	const connection = new Connection({ command: [localDaemon()] }),
		env = new RemoteExecutionEnv({ connection, id: "large-text", cwd });
	try {
		const text = "a".repeat(524287) + "🙂" + "b".repeat(524285) + "界" + "c".repeat(4 * 524288 + 7);
		getOrThrow(await env.writeFile("large", text, context));
		expect(getOrThrow(await env.readTextFile("large", context))).toBe(text);
		getOrThrow(await env.writeFile("small", "界", context));
		expect(Buffer.from(getOrThrow(await env.readBinaryFile("small", context))).toString("utf8")).toBe("界");
		getOrThrow(await env.appendFile("small", "tail", context));
		expect(getOrThrow(await env.readTextFile("small", context))).toBe("界tail");
	} finally {
		connection.close();
		await rm(cwd, { recursive: true, force: true });
	}
});

test("invalid execution deadlines fail before starting any connection", async () => {
	let launches = 0;
	const connection = new Connection({
		command: async () => {
			launches++;
			return [localDaemon()];
		},
	});
	const env = new RemoteExecutionEnv({ connection, id: "invalid-timeouts", cwd: tmpdir() });
	try {
		for (const timeout of [-1, 0, NaN, Infinity, 2147483.648]) {
			const result = await env.exec("must not run", { timeout }, context);
			expect(result).toMatchObject({ ok: false, error: { code: "timeout" } });
		}
		expect(launches).toBe(0);
	} finally {
		connection.close();
	}
});

test("an output callback failure aborts its command and a later command still succeeds", async () => {
	const connection = new Connection({ command: [localDaemon()] });
	const env = new RemoteExecutionEnv({ connection, id: "output-failure", cwd: tmpdir() });
	try {
		const cause = new Error("Cannot consume output");
		const failed = await env.exec(
			[process.execPath, "-e", "process.stdout.write('ready'); setTimeout(()=>{},10000)"],
			{
				onOutput() {
					throw cause;
				},
			},
			context,
		);
		expect(failed).toMatchObject({ ok: false, error: { code: "callback_error", message: cause.message, cause } });
		const output: string[] = [];
		expect(
			getOrThrow(
				await env.exec(
					[process.execPath, "-e", "process.stdout.write('recovered')"],
					{ onOutput: (text) => output.push(text) },
					context,
				),
			),
		).toMatchObject({ exitCode: 0 });
		expect(output.join("")).toBe("recovered");
	} finally {
		await env.cleanup(context);
		connection.close();
	}
});
