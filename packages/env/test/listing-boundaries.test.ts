import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT as context } from "@axi/objects/context";
import { FileError } from "@axi/durable/env";
import { Connection } from "../src/connection.ts";
import { listFilesOver, LocalExecutionEnv } from "../src/list-files.ts";
import { openProcess } from "../src/process.ts";
import { localDaemon } from "../src/ssh.ts";

const peer = [process.execPath, fileURLToPath(new URL("./fixtures/peer.ts", import.meta.url))];
afterEach(() => vi.unstubAllEnvs());

test("a daemon without advertised features rejects process and listing operations before dispatch", async () => {
	const connection = new Connection({ command: peer });
	try {
		await expect(openProcess(connection, { cwd: "/work", argv: ["node"], onStdout() {} })).rejects.toMatchObject({
			code: "not_supported",
		});
		expect(await listFilesOver(connection, "/work", undefined, context)).toMatchObject({
			ok: false,
			error: { code: "not_supported", path: "/work" },
		});
	} finally {
		connection.close();
	}
});

test.each([false, true])("listing frames preserve UTF-8 paths, file kinds and truncation: %s", async (truncated) => {
	const payload = Buffer.from("f日本🙂.ts\0ddirectory\0llink\0").toString("base64");
	const connection = new Connection({
		command: [...peer, "--features", '["listFiles"]', "--listing", payload, ...(truncated ? ["--truncated"] : [])],
	});
	try {
		expect(
			await listFilesOver(connection, "/work", { hidden: true, gitignore: false, maxBytes: 1000 }, context),
		).toEqual({
			ok: true,
			value: {
				entries: [
					{ path: "日本🙂.ts", kind: "file" },
					{ path: "directory", kind: "directory" },
					{ path: "link", kind: "symlink" },
				],
				truncated,
			},
		});
	} finally {
		connection.close();
	}
});

test("an unknown record kind and an incomplete final path are not exposed as files", async () => {
	const connection = new Connection({
		command: [
			...peer,
			"--features",
			'["listFiles"]',
			"--listing",
			Buffer.from("xunknown\0fcomplete\0fpartial").toString("base64"),
		],
	});
	try {
		expect(await listFilesOver(connection, "/work", undefined, context)).toEqual({
			ok: true,
			value: { entries: [{ path: "complete", kind: "file" }], truncated: false },
		});
	} finally {
		connection.close();
	}
});

test("invalid listing limits fail before launching a daemon", async () => {
	let starts = 0;
	const connection = new Connection({
		command: async () => {
			starts++;
			return peer;
		},
	});
	try {
		for (const field of ["maxEntries", "maxBytes", "timeoutMs"] as const)
			for (const value of [-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1])
				expect(await listFilesOver(connection, "/work", { [field]: value }, context)).toMatchObject({
					ok: false,
					error: { code: "invalid", path: "/work" },
				});
		expect(starts).toBe(0);
	} finally {
		connection.close();
	}
});

test("an already-aborted listing never starts the transport", async () => {
	let starts = 0;
	const connection = new Connection({
		command: async () => {
			starts++;
			return peer;
		},
	});
	try {
		expect(
			await listFilesOver(connection, "/work", undefined, { ...context, abortSignal: AbortSignal.abort() }),
		).toMatchObject({ ok: false, error: { code: "aborted" } });
		expect(starts).toBe(0);
	} finally {
		connection.close();
	}
});

test("local listing preserves a path-resolution error without contacting the daemon", async () => {
	const connection = new Connection({ command: [] });
	const env = new LocalExecutionEnv({ connection, cwd: tmpdir() });
	const request = vi.spyOn(connection, "request");
	const failed = { ok: false, error: new FileError("permission_denied", "No access", "private") } as const;
	const resolve = vi.spyOn(env, "absolutePath").mockResolvedValueOnce(failed);
	try {
		expect(await env.listFiles("private", undefined, context)).toBe(failed);
		expect(request).not.toHaveBeenCalled();
	} finally { resolve.mockRestore(); request.mockRestore(); connection.close(); }
});

test.each([false, true])("process environment inheritance is explicit: %s", async (inheritEnv) => {
	vi.stubEnv("AXI_PROCESS_TEST_MARKER", "ambient");
	const connection = new Connection({ command: [localDaemon()] });
	const output: Uint8Array[] = [];
	try {
		const process = await openProcess(connection, {
			cwd: tmpdir(),
			argv: [
				globalThis.process.execPath,
				"-e",
				"console.log(JSON.stringify([process.env.AXI_PROCESS_TEST_MARKER ?? null, process.env.AXI_EXPLICIT_VALUE]));",
			],
			inheritEnv,
			env: { AXI_EXPLICIT_VALUE: "passed" },
			onStdout: (bytes) => output.push(bytes),
		});
		expect(await process.exited).toBe(0);
		expect(JSON.parse(Buffer.concat(output).toString())).toEqual([inheritEnv ? "ambient" : null, "passed"]);
	} finally {
		connection.close();
	}
});
