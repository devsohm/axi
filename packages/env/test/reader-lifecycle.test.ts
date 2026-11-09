import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@axi/objects/context";
import { getOrThrow } from "@axi/durable/env";
import { expect, test } from "vitest";
import { Connection, localDaemon, RemoteExecutionEnv } from "../src/index.ts";

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
