import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { BACKGROUND_CONTEXT as context, withAbortSignal } from "@axi/objects/context";
import { getOrThrow } from "@axi/durable/env";
import { Connection, RemoteExecutionEnv, nodePlatform } from "../src/index.ts";

test("a Windows peer resolves home, file URLs, absolute paths and per-drive working directories", async () => {
	const connection = new Connection({
		command: [process.execPath, fileURLToPath(new URL("./fixtures/peer.ts", import.meta.url)), "--windows"],
	});
	const env = new RemoteExecutionEnv({ connection, id: "windows-paths", cwd: "C:\\project" });
	try {
		for (const [input, expected] of [
			["~", "C:\\Users\\Tester"],
			["~/docs", "C:\\Users\\Tester\\docs"],
			["~\\docs", "C:\\Users\\Tester\\docs"],
			["file:///D:/folder/file.txt", "D:\\folder\\file.txt"],
			["C:\\folder\\..\\file.txt", "C:\\file.txt"],
			["D:relative.txt", "D:\\other\\relative.txt"],
			["E:relative.txt", "E:\\relative.txt"],
			["Z:relative.txt", "Z:\\relative.txt"],
			["C:relative.txt", "C:\\project\\relative.txt"],
			["nested/file.txt", "C:\\project\\nested\\file.txt"],
			["", "C:\\project"],
		])
			expect(getOrThrow(await env.absolutePath(input, context))).toBe(expected);
		expect(getOrThrow(await env.joinPath(["C:\\project", "nested", "..", "file.txt"], context))).toBe(
			"C:\\project\\file.txt",
		);
		expect(nodePlatform({ os: "windows", arch: "x86_64" })).toEqual({ platform: "win32", arch: "x64" });
	} finally {
		connection.close();
	}
});

test("POSIX path resolution preserves remote roots and reports cancellation without filesystem operations", async () => {
	const connection = new Connection({
		command: [process.execPath, fileURLToPath(new URL("./fixtures/peer.ts", import.meta.url))],
	});
	const env = new RemoteExecutionEnv({ connection, id: "posix-paths", cwd: "/project" });
	try {
		for (const [input, expected] of [
			["~", "/home/test"],
			["~/docs", "/home/test/docs"],
			["../file", "/file"],
			["file:///tmp/a%20b", "/tmp/a b"],
		])
			expect(getOrThrow(await env.absolutePath(input, context))).toBe(expected);
		const cancelled = await env.absolutePath("/file", withAbortSignal(AbortSignal.abort(), context));
		expect(cancelled).toMatchObject({ ok: false, error: { code: "aborted" } });
		expect(nodePlatform({ os: "macos", arch: "aarch64" })).toEqual({ platform: "darwin", arch: "arm64" });
		expect(nodePlatform({ os: "other", arch: "x86" })).toEqual({ platform: "other", arch: "ia32" });
	} finally {
		connection.close();
	}
});
