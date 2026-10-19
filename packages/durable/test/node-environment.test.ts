import { mkdtemp, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { Dir, type Dirent } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, type Context, withAbortSignal } from "@axi/chord/context";
import { afterEach, expect, it, vi } from "vitest";
import { type FileError, getOrThrow, ok, type Result } from "../src/env/index.ts";
import { NodeExecutionEnv } from "../src/env/node.ts";

it("allows a subclass to identify a separate filesystem", () => {
	class SeparateFileSystem extends NodeExecutionEnv {
		override readonly id = "separate-filesystem";
	}
	const environment: NodeExecutionEnv = new SeparateFileSystem({ cwd: process.cwd() });
	expect(environment.id).toBe("separate-filesystem");
});

const directories: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
async function fixture(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "axi-env-"));
	directories.push(path);
	return path;
}

it("completes an empty directory page when cancellation arrives with its final read", async () => {
	const cwd = await fixture();
	const env = new NodeExecutionEnv({ cwd });
	const reader = getOrThrow(await env.openDirReader(".", BACKGROUND_CONTEXT));
	const controller = new AbortController();
	const read: () => Promise<Dirent | null> = Dir.prototype.read;
	const intercepted = vi.spyOn(Dir.prototype, "read").mockImplementation(function (this: Dir) {
		return read.call(this).then((entry) => {
			if (entry === null) controller.abort();
			return entry;
		});
	});
	try {
		expect(await reader.next(10, withAbortSignal(controller.signal, BACKGROUND_CONTEXT))).toEqual({
			ok: true,
			value: { entries: [], done: true },
		});
		expect(controller.signal.aborted).toBe(true);
	} finally {
		intercepted.mockRestore();
		await reader.close(BACKGROUND_CONTEXT);
		await env.cleanup(BACKGROUND_CONTEXT);
	}
});

it("preserves callback errors after shell output has spilled", async () => {
	const cwd = await fixture();
	const spillPath = join(cwd, "output.log");
	const env = new NodeExecutionEnv({ cwd });
	vi.spyOn(env, "createTempFile").mockImplementation(async () => {
		await writeFile(spillPath, "");
		return ok(spillPath);
	});
	try {
		const result = await env.exec(
			[
				process.execPath,
				"-e",
				`process.stdout.write("prefix\\n"); const timer = setInterval(() => { if (require("node:fs").existsSync(${JSON.stringify(spillPath)})) { clearInterval(timer); process.stdout.write("trigger\\n"); } }, 5);`,
			],
			{
				timeout: 5,
				spill: { afterBytes: 1, afterLines: 1 },
				onOutput: (text) => {
					if (text.includes("trigger")) throw new Error("callback failed");
				},
			},
			BACKGROUND_CONTEXT,
		);
		expect(result).toMatchObject({
			ok: false,
			error: { code: "callback_error", message: "callback failed", cause: { message: "callback failed" } },
		});
		if (!result.ok) expect(result.error.spillPath).toBeUndefined();
		expect(await readFile(spillPath, "utf8")).toContain("prefix\n");
	} finally {
		await env.cleanup(BACKGROUND_CONTEXT);
	}
});

it.skipIf(process.platform === "win32")("uses null stdin for ordinary commands", async () => {
	const cwd = await fixture();
	const env = new NodeExecutionEnv({ cwd });
	let output = "";
	try {
		const result = await env.exec(
			[process.execPath, "-e", 'process.stdout.write(String(require("node:fs").fstatSync(0).isCharacterDevice()))'],
			{
				onOutput: (text) => {
					output += text;
				},
			},
			BACKGROUND_CONTEXT,
		);
		expect(result).toEqual({ ok: true, value: { exitCode: 0 } });
		expect(output).toBe("true");
	} finally {
		await env.cleanup(BACKGROUND_CONTEXT);
	}
});

it("reports invalid filesystem and execution inputs consistently", async () => {
	const cwd = await fixture();
	await writeFile(join(cwd, "sample"), "value");
	await symlink("sample", join(cwd, "link"));
	const env = new NodeExecutionEnv({ cwd });
	expect
		.soft(
			await new NodeExecutionEnv({ cwd, watch: { mode: "polling", maxDirectories: 0 } }).watch(
				[{ path: "." }],
				() => {},
				BACKGROUND_CONTEXT,
			),
		)
		.toMatchObject({
			ok: false,
			error: { code: "invalid", message: "Watched paths exceed 0 directories", path: undefined },
		});
	const directory = getOrThrow(await env.openDirReader(".", BACKGROUND_CONTEXT));
	try {
		expect.soft(await directory.next(0, BACKGROUND_CONTEXT)).toMatchObject({
			ok: false,
			error: { code: "invalid", message: "maxEntries must be a positive safe integer" },
		});
	} finally {
		await directory.close(BACKGROUND_CONTEXT);
	}
	expect.soft(await env.openBinaryReader("link", { noFollow: true }, BACKGROUND_CONTEXT)).toMatchObject({
		ok: false,
		error: { code: "invalid", message: "Refusing to follow a symbolic link" },
	});
	expect.soft(await env.openBinaryReader(".", undefined, BACKGROUND_CONTEXT)).toMatchObject({
		ok: false,
		error: { code: "is_directory", message: "EISDIR: illegal operation on a directory, read" },
	});
	expect.soft(await env.truncateFile("sample", -1, BACKGROUND_CONTEXT)).toMatchObject({
		ok: false,
		error: { code: "invalid", message: "File size must be a non-negative safe integer" },
	});
	expect.soft(await env.exec([], undefined, BACKGROUND_CONTEXT)).toMatchObject({
		ok: false,
		error: { code: "spawn_error", message: "Empty argv: no program to run" },
	});
	for (const timeout of [0, Infinity]) {
		expect.soft(await env.exec([process.execPath], { timeout }, BACKGROUND_CONTEXT)).toMatchObject({
			ok: false,
			error: { code: "timeout", message: "Invalid timeout: must be a finite number of seconds" },
		});
	}
	expect.soft(await env.exec([process.execPath], { timeout: 2147483.648 }, BACKGROUND_CONTEXT)).toMatchObject({
		ok: false,
		error: { code: "timeout", message: "Invalid timeout: maximum is 2147483.647 seconds" },
	});
	expect.soft(await env.exec([process.execPath], { cwd: "absent" }, BACKGROUND_CONTEXT)).toMatchObject({
		ok: false,
		error: {
			code: "spawn_error",
			message: `Working directory does not exist: ${join(cwd, "absent")}\nCannot execute bash commands.`,
		},
	});
	const shellPath = join(cwd, "absent-shell");
	expect
		.soft(await new NodeExecutionEnv({ cwd, shellPath }).exec("true", undefined, BACKGROUND_CONTEXT))
		.toMatchObject({
			ok: false,
			error: { code: "shell_unavailable", message: `Custom shell path not found: ${shellPath}` },
		});
	expect
		.soft(await new NodeExecutionEnv({ cwd, shellPath: "" }).exec("exit 0", undefined, BACKGROUND_CONTEXT))
		.toEqual({
			ok: true,
			value: { exitCode: 0 },
		});
});

it("preserves reader ranges and reports which reader was closed", async () => {
	const cwd = await fixture();
	await writeFile(join(cwd, "sample"), "a\nb");
	const env = new NodeExecutionEnv({ cwd });
	const binary = getOrThrow(await env.openBinaryReader("sample", undefined, BACKGROUND_CONTEXT));
	try {
		expect.soft(await binary.scanLines({ startLine: 0, endLine: Infinity }, BACKGROUND_CONTEXT)).toEqual({
			ok: true,
			value: {
				newlines: 1,
				start: 0,
				end: 3,
				firstLineEnd: 1,
				lastLineStart: 2,
				selectedBytes: 3,
				firstLineBytes: 1,
			},
		});
		expect.soft(await binary.read(-1, 1, BACKGROUND_CONTEXT)).toMatchObject({
			ok: false,
			error: { code: "invalid", message: "Offset and length must be non-negative safe integers" },
		});
	} finally {
		await binary.close(BACKGROUND_CONTEXT);
	}
	expect.soft(await binary.info(BACKGROUND_CONTEXT)).toMatchObject({
		ok: false,
		error: { code: "invalid", message: "Binary reader is closed" },
	});
	const text = getOrThrow(await env.openTextLineReader("sample", BACKGROUND_CONTEXT));
	await text.close(BACKGROUND_CONTEXT);
	expect.soft(await text.readLine(BACKGROUND_CONTEXT)).toMatchObject({
		ok: false,
		error: { code: "invalid", message: "Text line reader is closed" },
	});
	const directory = getOrThrow(await env.openDirReader(".", BACKGROUND_CONTEXT));
	await directory.close(BACKGROUND_CONTEXT);
	expect.soft(await directory.next(1, BACKGROUND_CONTEXT)).toMatchObject({
		ok: false,
		error: { code: "invalid", message: "Directory reader is closed" },
	});
});

it.skipIf(process.platform === "win32")("counts a dangling symlink as an existing path", async () => {
	const cwd = await fixture();
	await symlink("absent", join(cwd, "dangling"));
	await writeFile(join(cwd, "regular"), "value");
	const env = new NodeExecutionEnv({ cwd });
	try {
		expect(await env.exists("dangling", BACKGROUND_CONTEXT)).toEqual({ ok: true, value: true });
		expect(getOrThrow(await env.fileInfo("dangling", BACKGROUND_CONTEXT)).kind).toBe("symlink");
		expect(await env.exists("regular", BACKGROUND_CONTEXT)).toEqual({ ok: true, value: true });
		expect(await env.exists("absent", BACKGROUND_CONTEXT)).toEqual({ ok: true, value: false });
	} finally {
		await env.cleanup(BACKGROUND_CONTEXT);
	}
});

it.skipIf(process.platform === "win32")("rejects unsupported file kinds in exists", async () => {
	const cwd = await fixture();
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(join(cwd, "socket"), resolve);
	});
	try {
		expect(await new NodeExecutionEnv({ cwd }).exists("socket", BACKGROUND_CONTEXT)).toMatchObject({
			ok: false,
			error: { code: "invalid" },
		});
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

it("reports the destination when rename is already cancelled", async () => {
	const cwd = await fixture();
	const controller = new AbortController();
	controller.abort();
	expect(
		await new NodeExecutionEnv({ cwd }).renameFile(
			"source",
			"destination",
			withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
		),
	).toMatchObject({ ok: false, error: { code: "aborted", path: join(cwd, "destination") } });
});

it("does not assign a file path to cancelled watcher or temporary resource acquisition", async () => {
	const env = new NodeExecutionEnv({ cwd: await fixture() });
	const context = withAbortSignal(AbortSignal.abort("cancelled"), BACKGROUND_CONTEXT);
	for (const result of [
		await env.watch([{ path: "absent" }], () => {}, context),
		await env.createTempDir("cancelled-", context),
		await env.createTempFile(undefined, context),
	]) {
		expect(result).toMatchObject({
			ok: false,
			error: { name: "FileError", code: "aborted", message: "aborted", path: undefined },
		});
	}
});

it("captures watch exclusions and limits when the watcher opens", async () => {
	const cwd = await fixture();
	const options = { mode: "polling" as const, pollIntervalMs: 10, maxDirectories: 10 };
	const exclude = { names: [] as string[] };
	const changes: string[] = [];
	const errors: FileError[] = [];
	const watcher = getOrThrow(
		await new NodeExecutionEnv({ cwd, watch: options }).watch(
			[{ path: ".", exclude }],
			(change) => {
				if ("paths" in change) changes.push(...change.paths);
				else if ("error" in change) errors.push(change.error);
			},
			BACKGROUND_CONTEXT,
		),
	);
	try {
		exclude.names.push("visible");
		options.maxDirectories = 0;
		await writeFile(join(cwd, "visible"), "value");
		await expect.poll(() => changes, { timeout: 2000 }).toContain(join(cwd, "visible"));
		expect(errors).toEqual([]);
	} finally {
		await watcher.close(BACKGROUND_CONTEXT);
	}
});

it("reports the first affected target when their shared ancestor changes", async () => {
	const cwd = await fixture();
	const env = new NodeExecutionEnv({ cwd, watch: { mode: "polling", pollIntervalMs: 10 } });
	getOrThrow(await env.createDir("parent", undefined, BACKGROUND_CONTEXT));
	const changes: string[][] = [];
	const watcher = getOrThrow(
		await env.watch(
			[{ path: "parent/first" }, { path: "parent/second" }],
			(change) => {
				if ("paths" in change) changes.push([...change.paths]);
			},
			BACKGROUND_CONTEXT,
		),
	);
	try {
		getOrThrow(await env.renameFile("parent", "previous", BACKGROUND_CONTEXT));
		getOrThrow(await env.createDir("parent", undefined, BACKGROUND_CONTEXT));
		await expect.poll(() => changes, { timeout: 2000 }).toEqual([[join(cwd, "parent/first")]]);
	} finally {
		await watcher.close(BACKGROUND_CONTEXT);
	}
});

it("supports an inherited environment that intercepts reads", async () => {
	const cwd = await fixture();
	await writeFile(join(cwd, "sample"), "value");
	const env = new NodeExecutionEnv({ cwd });
	const wrapped: NodeExecutionEnv = Object.create(env);
	let reads = 0;
	wrapped.openBinaryReader = async (...args) => {
		reads++;
		return env.openBinaryReader(...args);
	};
	expect(getOrThrow(await wrapped.absolutePath("sample", BACKGROUND_CONTEXT))).toBe(join(cwd, "sample"));
	expect(getOrThrow(await wrapped.exists("sample", BACKGROUND_CONTEXT))).toBe(true);
	const reader = getOrThrow(await wrapped.openBinaryReader("sample", undefined, BACKGROUND_CONTEXT));
	try {
		const bytes = getOrThrow(await reader.read(0, 5, BACKGROUND_CONTEXT));
		expect(new TextDecoder().decode(bytes)).toBe("value");
		const copy = bytes.slice();
		expect(structuredClone(copy, { transfer: [copy.buffer] })).toEqual(new Uint8Array([118, 97, 108, 117, 101]));
		expect(reads).toBe(1);
	} finally {
		await reader.close(BACKGROUND_CONTEXT);
	}
});

it("reports failure to open a spill independently of its generated name", async () => {
	const cwd = await fixture();
	class UnwritableSpill extends NodeExecutionEnv {
		override async createTempFile(
			_options: { prefix?: string; suffix?: string } | undefined,
			_context: Context,
		): Promise<Result<string, FileError>> {
			return ok(join(cwd, "absent", "output.log"));
		}
	}
	const result = await new UnwritableSpill({ cwd }).exec(
		[process.execPath, "-e", "process.stdout.write('output')"],
		{ spill: { afterBytes: 0, afterLines: 0 } },
		BACKGROUND_CONTEXT,
	);
	expect(result).toMatchObject({
		ok: false,
		error: { code: "unknown", message: expect.stringContaining("Failed to preserve complete shell output") },
	});
});

it("closes a binary handle when cancellation happens while opening it", async () => {
	const cwd = await fixture();
	const path = join(cwd, "data");
	await writeFile(path, "data");
	const probe = await open(path, "r");
	const prototype: typeof probe = Object.getPrototypeOf(probe);
	await probe.close();
	const originalStat = prototype.stat;
	let opened: typeof probe | undefined;
	const controller = new AbortController();
	vi.spyOn(prototype, "stat").mockImplementation(async function (this: typeof probe) {
		opened = this;
		const result = await originalStat.call(this);
		controller.abort();
		return result;
	});
	expect(
		await new NodeExecutionEnv({ cwd }).openBinaryReader(
			"data",
			undefined,
			withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
		),
	).toMatchObject({ ok: false, error: { code: "aborted" } });
	expect(opened?.fd).toBe(-1);
});

it("leaves directory text-reader validation to the first read", async () => {
	if (process.platform === "win32") return;
	const env = new NodeExecutionEnv({ cwd: await fixture() });
	const reader = getOrThrow(await env.openTextLineReader(".", BACKGROUND_CONTEXT));
	try {
		expect(await reader.readLine(BACKGROUND_CONTEXT)).toMatchObject({ ok: false, error: { code: "is_directory" } });
	} finally {
		await reader.close(BACKGROUND_CONTEXT);
	}
});

it("uses raw byte limits even when invalid UTF-8 expands in displayed text", async () => {
	const cwd = await fixture();
	const env = new NodeExecutionEnv({ cwd });
	let displayed = "";
	const result = getOrThrow(
		await env.exec(
			[process.execPath, "-e", "process.stdout.write(Buffer.from([128,129]))"],
			{
				spill: { afterBytes: 2, afterLines: 1 },
				onOutput: (text) => {
					displayed += text;
				},
			},
			BACKGROUND_CONTEXT,
		),
	);
	expect(displayed).toBe("\ufffd\ufffd");
	expect(result.spillPath).toBeUndefined();
	const spilled = getOrThrow(
		await env.exec(
			[process.execPath, "-e", "process.stdout.write(Buffer.from([128,129]))"],
			{ spill: { afterBytes: 1, afterLines: 1 } },
			BACKGROUND_CONTEXT,
		),
	);
	expect(spilled.spillPath).toBeDefined();
	if (spilled.spillPath !== undefined) {
		directories.push(join(spilled.spillPath, ".."));
		expect([...(await readFile(spilled.spillPath))]).toEqual([128, 129]);
	}
});
