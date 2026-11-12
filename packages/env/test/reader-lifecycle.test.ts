import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@axi/objects/context";
import { getOrThrow } from "@axi/durable/env";
import { expect, test } from "vitest";
import { Connection, localDaemon, RemoteExecutionEnv } from "../src/index.ts";
import { RemoteError } from "../src/connection.ts";

test("closing a real daemon connection makes readers and environment operations return errors without restarting", async () => {
	const directory = await mkdtemp(join(tmpdir(), "axi-closed-readers-"));
	let launches = 0;
	const connection = new Connection({
		command: async () => {
			launches++;
			return [localDaemon()];
		},
	});
	const env = new RemoteExecutionEnv({ connection, id: "closed-readers", cwd: directory });
	try {
		await writeFile(join(directory, "data"), "one\ntwo\n");
		const binary = getOrThrow(await env.openBinaryReader("data", undefined, context));
		const text = getOrThrow(await env.openTextLineReader("data", context));
		const entries = getOrThrow(await env.openDirReader(".", context));
		connection.close();
		try {
			for (const operation of [
				() => binary.info(context),
				() => binary.read(0, 3, context),
				() => binary.scanLines({ startLine: 0, endLine: 1 }, context),
				() => text.readLine(context),
				() => entries.next(1, context),
				() => env.joinPath(["a", "b"], context),
				() => env.createTempDir("axi-closed-", context),
				() => env.createTempFile(undefined, context),
				() => env.watch([{ path: "." }], () => {}, context),
				() => env.exec([process.execPath, "-e", "process.exit(99)"], undefined, context),
				() => env.exec([process.execPath, "-e", "process.exit(99)"], { cwd: "." }, context),
			]) {
				expect(await operation()).toMatchObject({
					ok: false,
					error: { code: "unknown", message: expect.stringMatching(/connection/i) },
				});
			}
			expect(launches).toBe(1);
		} finally {
			await Promise.all([binary.close(context), text.close(context), entries.close(context)]);
		}
	} finally {
		connection.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("cancellation after remote open closes every newly acquired reader handle", async () => {
	const directory = await mkdtemp(join(tmpdir(), "axi-reader-admission-"));
	const connection = new Connection({ command: [localDaemon()] });
	const env = new RemoteExecutionEnv({ connection, id: "reader-admission", cwd: directory });
	await writeFile(join(directory, "data"), "retained");
	const request = connection.request.bind(connection);
	try {
		for (const kind of ["binary", "text", "directory"]) {
			const controller = new AbortController(),
				closed: number[] = [];
			connection.request = async (op, fields, options) => {
				const response = await request(op, fields, options);
				if (op === "open" || op === "opendir") controller.abort();
				if (op === "close" && typeof fields?.handle === "number") closed.push(fields.handle);
				return response;
			};
			const call = { ...context, abortSignal: controller.signal };
			const result =
				kind === "binary"
					? await env.openBinaryReader("data", undefined, call)
					: kind === "text"
						? await env.openTextLineReader("data", call)
						: await env.openDirReader(".", call);
			expect(result).toMatchObject({ ok: false, error: { code: "aborted" } });
			expect(closed).toHaveLength(1);
		}
	} finally {
		connection.request = request;
		connection.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("oversized files fail before allocation and a later read on the same connection still works", async () => {
	const directory = await mkdtemp(join(tmpdir(), "axi-reader-size-"));
	const connection = new Connection({ command: [localDaemon()] });
	const env = new RemoteExecutionEnv({ connection, id: "reader-size", cwd: directory });
	try {
		const file = await open(join(directory, "sparse"), "w");
		try {
			await file.truncate(2147483648);
		} finally {
			await file.close();
		}
		for (const result of [await env.readTextFile("sparse", context), await env.readBinaryFile("sparse", context)])
			expect(result).toMatchObject({
				ok: false,
				error: { code: "unknown", message: expect.stringContaining("greater than 2 GiB") },
			});
		getOrThrow(await env.writeFile("small", "still working", context));
		expect(getOrThrow(await env.readTextFile("small", context))).toBe("still working");
	} finally {
		connection.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test.each(["binary", "text", "directory"] as const)(
	"a lost close acknowledgement leaves the %s reader closed and releases its remote handle",
	async (kind) => {
		const directory = await mkdtemp(join(tmpdir(), "axi-reader-close-"));
		const connection = new Connection({ command: [localDaemon()] });
		const env = new RemoteExecutionEnv({ connection, id: "reader-close", cwd: directory });
		const request = connection.request.bind(connection);
		try {
			await writeFile(join(directory, "data"), "retained");
			const reader =
				kind === "binary"
					? getOrThrow(await env.openBinaryReader("data", undefined, context))
					: kind === "text"
						? getOrThrow(await env.openTextLineReader("data", context))
						: getOrThrow(await env.openDirReader(".", context));
			const released: number[] = [];
			connection.request = async (op, fields, options) => {
				const reply = await request(op, fields, options);
				if (op === "close" && typeof fields?.handle === "number") {
					released.push(fields.handle);
					throw new RemoteError({ code: "unknown", message: "Close acknowledgement lost" });
				}
				return reply;
			};
			await reader.close(context);
			await reader.close(context);
			expect(released).toHaveLength(1);
			await expect(
				request(kind === "directory" ? "readdir" : "fstat", { handle: released[0], max: 1 }),
			).rejects.toMatchObject({ code: "EBADF" });
			const result =
				"read" in reader
					? await reader.read(0, 1, context)
					: "readLine" in reader
						? await reader.readLine(context)
						: await reader.next(1, context);
			expect(result).toMatchObject({ ok: false, error: { code: "invalid" } });
			expect(getOrThrow(await env.readTextFile("data", context))).toBe("retained");
		} finally {
			connection.request = request;
			connection.close();
			await rm(directory, { recursive: true, force: true });
		}
	},
);

test("an EOF read remains successful when later prefetched reads fail", async () => {
	const directory = await mkdtemp(join(tmpdir(), "axi-reader-prefetch-"));
	const connection = new Connection({ command: [localDaemon()] });
	const env = new RemoteExecutionEnv({ connection, id: "reader-prefetch", cwd: directory });
	const request = connection.request.bind(connection);
	try {
		await writeFile(join(directory, "empty"), "");
		const reader = getOrThrow(await env.openBinaryReader("empty", undefined, context));
		connection.request = async (op, fields, options) => {
			if (op === "pread" && typeof fields?.offset === "number" && fields.offset > 0)
				throw new RemoteError({ code: "EIO", message: "Speculative read failed" });
			return request(op, fields, options);
		};
		try {
			expect(getOrThrow(await reader.read(0, 1_048_576, context))).toEqual(new Uint8Array());
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(getOrThrow(await reader.info(context)).size).toBe(0);
		} finally {
			await reader.close(context);
		}
	} finally {
		connection.request = request;
		connection.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test.runIf(process.platform === "linux")(
	"zero-size proc files stream until EOF for text and binary readers",
	async () => {
		const connection = new Connection({ command: [localDaemon()] });
		const env = new RemoteExecutionEnv({ connection, id: "pseudo-files", cwd: "/" });
		try {
			const info = getOrThrow(await env.fileInfo("/proc/self/status", context));
			expect(info.size).toBe(0);
			const text = getOrThrow(await env.readTextFile("/proc/self/status", context));
			expect(text).toMatch(/^Name:\s+axi-env/m);
			expect(text).toMatch(/^Pid:\s+\d+$/m);
			expect(Buffer.from(getOrThrow(await env.readBinaryFile("/proc/self/status", context))).toString()).toMatch(
				/^Name:\s+axi-env/m,
			);
		} finally {
			connection.close();
		}
	},
);
