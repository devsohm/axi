import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@axi/objects/context";
import { getOrThrow } from "@axi/durable/env";
import { expect, test } from "vitest";
import { Connection, localDaemon, RemoteExecutionEnv } from "../src/index.ts";

test("a cancelled text read leaves its buffered next line available for a later read", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "axi-buffered-cancel-"));
	const connection = new Connection({ command: [localDaemon()] });
	const env = new RemoteExecutionEnv({ connection, id: "buffered-cancel", cwd });
	try {
		await writeFile(join(cwd, "data"), "one\ntwo\n");
		const reader = getOrThrow(await env.openTextLineReader("data", context));
		try {
			expect(getOrThrow(await reader.readLine(context))).toEqual({ text: "one", terminated: true });
			expect(await reader.readLine({ ...context, abortSignal: AbortSignal.abort() })).toMatchObject({
				ok: false,
				error: { code: "aborted" },
			});
			expect(getOrThrow(await reader.readLine(context))).toEqual({ text: "two", terminated: true });
		} finally {
			await reader.close(context);
		}
	} finally {
		connection.close();
		await rm(cwd, { recursive: true, force: true });
	}
});

test.each(["rename-resolution", "directory-response"] as const)(
	"cancellation at %s prevents a file mutation or a partial listing",
	async (boundary) => {
		const cwd = await mkdtemp(join(tmpdir(), "axi-file-boundary-cancel-"));
		const connection = new Connection({ command: [localDaemon()] });
		const env = new RemoteExecutionEnv({ connection, id: "file-boundary-cancel", cwd });
		const controller = new AbortController();
		const info = connection.info.bind(connection),
			request = connection.request.bind(connection);
		let resolutions = 0;
		try {
			await writeFile(join(cwd, "original"), "saved");
			await connection.info();
			connection.info = async (signal) => {
				const value = await info(signal);
				if (boundary === "rename-resolution" && ++resolutions === 2) controller.abort();
				return value;
			};
			connection.request = async (...args) => {
				const value = await request(...args);
				if (boundary === "directory-response" && args[0] === "readdir") controller.abort();
				return value;
			};
			const call = { ...context, abortSignal: controller.signal };
			expect(
				boundary === "rename-resolution"
					? await env.renameFile("original", "renamed", call)
					: await env.listDir(".", call),
			).toMatchObject({ ok: false, error: { code: "aborted" } });
			connection.info = info;
			connection.request = request;
			expect(getOrThrow(await env.readTextFile("original", context))).toBe("saved");
		} finally {
			connection.info = info;
			connection.request = request;
			connection.close();
			await rm(cwd, { recursive: true, force: true });
		}
	},
);

test.each(["binary", "text", "directory"] as const)(
	"cancellation after a %s response does not expose its data",
	async (kind) => {
		const cwd = await mkdtemp(join(tmpdir(), "axi-read-cancel-"));
		const connection = new Connection({ command: [localDaemon()] });
		const env = new RemoteExecutionEnv({ connection, id: "read-cancel", cwd });
		const controller = new AbortController();
		const request = connection.request.bind(connection);
		try {
			await writeFile(join(cwd, "data"), "one\ntwo\n");
			connection.request = async (op, fields, options) => {
				const response = await request(op, fields, options);
				if (op === "pread" || op === "readdir") controller.abort();
				return response;
			};
			const call = { ...context, abortSignal: controller.signal };
			if (kind === "binary") {
				const reader = getOrThrow(await env.openBinaryReader("data", undefined, context));
				try {
					expect(await reader.read(0, 4, call)).toMatchObject({ ok: false, error: { code: "aborted" } });
				} finally {
					await reader.close(context);
				}
			} else if (kind === "text") {
				const reader = getOrThrow(await env.openTextLineReader("data", context));
				try {
					expect(await reader.readLine(call)).toMatchObject({ ok: false, error: { code: "aborted" } });
				} finally {
					await reader.close(context);
				}
			} else {
				const reader = getOrThrow(await env.openDirReader(".", context));
				try {
					expect(await reader.next(1, call)).toMatchObject({ ok: false, error: { code: "aborted" } });
				} finally {
					await reader.close(context);
				}
			}
			connection.request = request;
			expect(getOrThrow(await env.readTextFile("data", context))).toBe("one\ntwo\n");
		} finally {
			connection.request = request;
			connection.close();
			await rm(cwd, { recursive: true, force: true });
		}
	},
);

test.each(["open", "pread", "listFiles"])(
	"cancellation at the %s boundary hides file data, releases handles and leaves the connection usable",
	async (boundary) => {
		const cwd = await mkdtemp(join(tmpdir(), "axi-transfer-cancel-"));
		const connection = new Connection({ command: [localDaemon()] });
		const env = new RemoteExecutionEnv({ connection, id: "transfer-cancel", cwd });
		const controller = new AbortController();
		const request = connection.request.bind(connection);
		let closed = 0;
		try {
			await writeFile(join(cwd, "data"), Buffer.alloc(1024 * 1024, 97));
			connection.request = async (operation, fields, options) => {
				const response = await request(operation, fields, options);
				if (operation === "close") closed++;
				if (operation === boundary) controller.abort();
				return response;
			};
			const call = { ...context, abortSignal: controller.signal };
			const result =
				boundary === "listFiles" ? await env.listFiles(".", undefined, call) : await env.readBinaryFile("data", call);
			expect(result).toMatchObject({ ok: false, error: { code: "aborted" } });
			expect(closed).toBe(boundary === "listFiles" ? 0 : 1);
			connection.request = request;
			expect(getOrThrow(await env.readTextFile("data", context))).toBe("a".repeat(1024 * 1024));
		} finally {
			connection.request = request;
			connection.close();
			await rm(cwd, { recursive: true, force: true });
		}
	},
);

test("cancellation during path resolution prevents a metadata request", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "axi-resolve-cancel-"));
	const connection = new Connection({ command: [localDaemon()] });
	const env = new RemoteExecutionEnv({ connection, id: "resolve-cancel", cwd });
	const controller = new AbortController();
	const info = connection.info.bind(connection);
	const request = connection.request.bind(connection);
	const operations: string[] = [];
	try {
		await connection.info();
		connection.info = async (signal) => {
			const result = await info(signal);
			controller.abort();
			return result;
		};
		connection.request = (...args) => {
			operations.push(args[0]);
			return request(...args);
		};
		expect(await env.fileInfo("data", { ...context, abortSignal: controller.signal })).toMatchObject({
			ok: false,
			error: { code: "aborted", path: join(cwd, "data") },
		});
		expect(operations).toEqual([]);
	} finally {
		connection.info = info;
		connection.request = request;
		connection.close();
		await rm(cwd, { recursive: true, force: true });
	}
});

test.each(["ENOENT", "EACCES", "unsupported"].flatMap((code) => ["reader", "listing"].map((method) => [code, method])))(
	"directory %s entries preserve failure semantics through %s",
	async (code, method) => {
		const cwd = await mkdtemp(join(tmpdir(), "axi-read-dir-entry-"));
		const connection = new Connection({ command: [localDaemon()] });
		const env = new RemoteExecutionEnv({ connection, id: "directory-errors", cwd });
		const request = connection.request.bind(connection);
		try {
			await writeFile(join(cwd, "visible"), "data");
			const reader = method === "reader" ? getOrThrow(await env.openDirReader(".", context)) : undefined;
			connection.request = async (op, fields, options) => {
				const response = await request(op, fields, options);
				if (op !== "readdir") return response;
				return {
					...response,
					json: {
						...response.json,
						entries: [
							code === "unsupported"
								? { name: "special", info: { name: "special", kind: "other", size: 0, mtimeSec: 0, mtimeNsec: 0 } }
								: { name: "inaccessible", error: { code, message: "Directory entry unavailable" } },
							...(response.json.entries as unknown[]),
						],
						done: true,
					},
				};
			};
			try {
				const result = reader ? await reader.next(10, context) : await env.listDir(".", context);
				if (code === "EACCES")
					expect(result).toMatchObject({
						ok: false,
						error: { code: "permission_denied", path: join(cwd, "inaccessible") },
					});
				else
					expect(result).toMatchObject({
						ok: true,
						value: reader
							? { entries: [{ name: "visible", path: join(cwd, "visible"), kind: "file" }], done: true }
							: [{ name: "visible", path: join(cwd, "visible"), kind: "file" }],
					});
			} finally {
				await reader?.close(context);
			}
		} finally {
			connection.request = request;
			connection.close();
			await rm(cwd, { recursive: true, force: true });
		}
	},
);

test("closed readers reject further operations without sending another request", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "axi-read-closed-"));
	const connection = new Connection({ command: [localDaemon()] });
	const env = new RemoteExecutionEnv({ connection, id: "closed-readers", cwd });
	const request = connection.request.bind(connection);
	try {
		await writeFile(join(cwd, "data"), "one\n");
		const binary = getOrThrow(await env.openBinaryReader("data", undefined, context));
		const text = getOrThrow(await env.openTextLineReader("data", context));
		const directory = getOrThrow(await env.openDirReader(".", context));
		await Promise.all([binary.close(context), text.close(context), directory.close(context)]);
		let requests = 0;
		connection.request = (...args) => {
			requests++;
			return request(...args);
		};
		for (const result of [
			await binary.info(context),
			await binary.scanLines({ startLine: 0 }, context),
			await text.readLine(context),
			await directory.next(1, context),
		])
			expect(result).toMatchObject({ ok: false, error: { code: "invalid" } });
		await Promise.all([binary.close(context), text.close(context), directory.close(context)]);
		expect(requests).toBe(0);
	} finally {
		connection.request = request;
		connection.close();
		await rm(cwd, { recursive: true, force: true });
	}
});
