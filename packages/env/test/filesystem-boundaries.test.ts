import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT as context } from "@axi/chord/context";
import { getOrThrow } from "@axi/durable/env";
import { expect, test } from "vitest";
import { Connection, localDaemon, RemoteExecutionEnv } from "../src/index.ts";

test("remote filesystem resolves file URLs, preserves empty files and reports invalid operations", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "axi-filesystem-"));
	const connection = new Connection({ command: [localDaemon()] });
	const env = new RemoteExecutionEnv({ connection, id: "boundary", cwd });
	try {
		getOrThrow(await env.writeFile("empty", "", context));
		expect(getOrThrow(await env.readTextFile("empty", context))).toBe("");
		expect([...getOrThrow(await env.readBinaryFile("empty", context))]).toEqual([]);
		getOrThrow(await env.writeFile("with space", "one\ntwo\nlast", context));
		expect(getOrThrow(await env.readTextFile(pathToFileURL(join(cwd, "with space")).href, context))).toBe(
			"one\ntwo\nlast",
		);
		expect(getOrThrow(await env.readTextLines("with space", { maxLines: 2 }, context))).toEqual(["one", "two"]);
		expect(getOrThrow(await env.readTextLines("with space", { maxLines: 0 }, context))).toEqual([]);
		expect(getOrThrow(await env.readTextLines("with space", undefined, context))).toEqual(["one", "two", "last"]);
		getOrThrow(await env.truncateFile("with space", 3, context));
		getOrThrow(await env.flushFile("with space", context));
		getOrThrow(await env.renameFile("with space", "renamed", context));
		expect(getOrThrow(await env.readTextFile("renamed", context))).toBe("one");
		expect(getOrThrow(await env.exists("with space", context))).toBe(false);
		expect(getOrThrow(await env.exists("renamed", context))).toBe(true);
		for (const size of [-1, 0.5, NaN, Infinity])
			expect(await env.truncateFile("renamed", size, context)).toMatchObject({ ok: false, error: { code: "invalid" } });
		expect(await env.readTextFile("absent", context)).toMatchObject({ ok: false, error: { code: "not_found" } });
		expect(await env.openDirReader("renamed", context)).toMatchObject({ ok: false, error: { code: "not_directory" } });
		expect(await env.readBinaryFile("renamed/child", context)).toMatchObject({
			ok: false,
			error: { code: "not_directory" },
		});
	} finally {
		await env.cleanup(context);
		connection.close();
		await rm(cwd, { recursive: true, force: true });
	}
});

test.skipIf(process.platform === "win32")(
	"remote readers reject symlinks when requested and cancellation preserves existing files",
	async () => {
		const cwd = await mkdtemp(join(tmpdir(), "axi-filesystem-cancel-"));
		const connection = new Connection({ command: [localDaemon()] });
		const env = new RemoteExecutionEnv({ connection, id: "boundary-cancel", cwd });
		try {
			getOrThrow(await env.writeFile("original", "retained", context));
			await symlink("original", join(cwd, "link"));
			expect(await env.openBinaryReader("link", { noFollow: true }, context)).toMatchObject({
				ok: false,
				error: { code: "invalid" },
			});
			expect(getOrThrow(await env.canonicalPath("link", context))).toBe(join(cwd, "original"));
			const cancelled = { ...context, abortSignal: AbortSignal.abort("cancelled") };
			for (const operation of [
				() => env.writeFile("original", "lost", cancelled),
				() => env.appendFile("original", "lost", cancelled),
				() => env.renameFile("original", "lost", cancelled),
				() => env.openBinaryReader("original", undefined, cancelled),
				() => env.openTextLineReader("original", cancelled),
				() => env.openDirReader(".", cancelled),
				() => env.createTempDir("axi-cancelled-", cancelled),
			])
				expect(await operation()).toMatchObject({ ok: false, error: { code: "aborted" } });
			expect(getOrThrow(await env.readTextFile("original", context))).toBe("retained");
			const reader = getOrThrow(await env.openBinaryReader("original", undefined, context));
			expect(await reader.read(0, 1, cancelled)).toMatchObject({ ok: false, error: { code: "aborted" } });
			await reader.close(context);
			expect(await reader.read(0, 1, context)).toMatchObject({ ok: false, error: { code: "invalid" } });
		} finally {
			await env.cleanup(context);
			connection.close();
			await rm(cwd, { recursive: true, force: true });
		}
	},
);
