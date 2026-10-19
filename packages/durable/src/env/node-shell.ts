import { spawn, type ChildProcess, type ChildProcessByStdio } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import { constants } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import type { Context } from "@axi/chord";
import { StreamDecoder } from "./decode.ts";
import {
	err,
	ExecutionError,
	ok,
	toError,
	type FileError,
	type Result,
	type ShellExecOptions,
	type ShellExecResult,
} from "./index.ts";

interface CommandHost {
	shellPath?: string;
	shellEnv?: NodeJS.ProcessEnv;
	resolve(path: string): string;
	createTempFile(options: { prefix?: string; suffix?: string }, context: Context): Promise<Result<string, FileError>>;
	processes: Set<ChildProcess>;
}

export function terminate(child: ChildProcess): void {
	if (child.pid === undefined) return;
	if (process.platform === "win32") {
		try {
			const killer = spawn(
				join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
				["/F", "/T", "/PID", String(child.pid)],
				{ stdio: "ignore", detached: true, windowsHide: true },
			);
			killer.once("error", () => {});
		} catch {}
	} else {
		try {
			process.kill(-child.pid, "SIGKILL");
		} catch {
			child.kill("SIGKILL");
		}
	}
}

async function available(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function locateShell(override: string | undefined): Promise<Result<string, ExecutionError>> {
	if (override)
		return (await available(override))
			? ok(override)
			: err(new ExecutionError("shell_unavailable", `Custom shell path not found: ${override}`));
	const candidates =
		process.platform === "win32"
			? [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]
					.filter((path): path is string => Boolean(path))
					.map((path) => `${path}\\Git\\bin\\bash.exe`)
			: ["/bin/bash"];
	for (const path of candidates) if (await available(path)) return ok(path);
	const located = await new Promise<string | undefined>((resolve) => {
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(
				process.platform === "win32" ? "where" : "which",
				[process.platform === "win32" ? "bash.exe" : "bash"],
				{
					stdio: ["ignore", "pipe", "ignore"],
					windowsHide: true,
				},
			);
		} catch {
			resolve(undefined);
			return;
		}
		let output = "";
		const timer = setTimeout(() => {
			if (child.pid !== undefined) terminate(child);
		}, 5000);
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (text: string) => {
			output += text;
		});
		child.on("error", () => {
			clearTimeout(timer);
			resolve(undefined);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve(code === 0 ? output.trim().split(/\r?\n/)[0] || undefined : undefined);
		});
	});
	if (located !== undefined && (await available(located))) return ok(located);
	if (process.platform !== "win32") return ok("sh");
	return err(
		new ExecutionError(
			"shell_unavailable",
			`No bash shell found. Options:\n  1. Install Git for Windows: https://git-scm.com/download/win\n  2. Add your bash to PATH (Cygwin, MSYS2, etc.)\n  3. Configure an explicit shellPath\n\nSearched Git Bash in:\n${candidates.map((path) => `  ${path}`).join("\n")}`,
		),
	);
}

export async function runCommand(
	host: CommandHost,
	command: string | readonly string[],
	options: ShellExecOptions | undefined,
	context: Context,
): Promise<Result<ShellExecResult, ExecutionError>> {
	if (context.abortSignal?.aborted) return err(new ExecutionError("aborted", "aborted"));
	const timeout = options?.timeout;
	if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0))
		return err(new ExecutionError("timeout", "Invalid timeout: must be a finite number of seconds"));
	if (timeout !== undefined && timeout * 1000 > 2147483647)
		return err(new ExecutionError("timeout", "Invalid timeout: maximum is 2147483.647 seconds"));
	let executable: string;
	let args: string[];
	let stdinCommand: string | undefined;
	if (typeof command === "string") {
		const shell = await locateShell(host.shellPath);
		if (!shell.ok) return shell;
		executable = shell.value;
		if (/^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/i.test(shell.value.replace(/\//g, "\\"))) {
			args = ["-s"];
			stdinCommand = command;
		} else args = ["-c", command];
	} else {
		if (!command.length) return err(new ExecutionError("spawn_error", "Empty argv: no program to run"));
		executable = command[0];
		args = command.slice(1);
	}
	const cwd = host.resolve(options?.cwd ?? ".");
	try {
		await stat(cwd);
	} catch (error) {
		return err(
			new ExecutionError(
				"spawn_error",
				`Working directory does not exist: ${cwd}\nCannot execute bash commands.`,
				toError(error),
			),
		);
	}
	if (context.abortSignal?.aborted) return err(new ExecutionError("aborted", "aborted"));
	const env =
		options?.inheritEnv === false ? { ...options.env } : { ...process.env, ...host.shellEnv, ...options?.env };
	return new Promise((resolve) => {
		let child: ChildProcessByStdio<Writable | null, Readable, Readable>;
		try {
			const spawnOptions = {
				cwd,
				env,
				detached: process.platform !== "win32",
				windowsHide: true,
			};
			child =
				stdinCommand === undefined
					? spawn(executable, args, { ...spawnOptions, stdio: ["ignore", "pipe", "pipe"] })
					: spawn(executable, args, { ...spawnOptions, stdio: "pipe" });
		} catch (error) {
			resolve(err(new ExecutionError("spawn_error", toError(error).message, toError(error))));
			return;
		}
		host.processes.add(child);
		let settled = false;
		let finishing = false;
		let exited = false;
		let code = 0;
		let timedOut = false;
		let callbackError: Error | undefined;
		let outputError: Error | undefined;
		let spawnError: Error | undefined;
		let spillPath: string | undefined;
		let spill: WriteStream | undefined;
		let prefix: Buffer[] = [];
		let bytes = 0;
		let newlines = 0;
		let lastByte: number | undefined;
		let pending = 0;
		let queue = Promise.resolve();
		let idleTimer: ReturnType<typeof setTimeout> | undefined;
		let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
		const decoders = { stdout: new StreamDecoder(), stderr: new StreamDecoder() };
		const signal = context.abortSignal;
		const abort = () => terminate(child);
		const pause = () => {
			child.stdout.pause();
			child.stderr.pause();
		};
		const resume = () => {
			if (!settled && !finishing) {
				child.stdout.resume();
				child.stderr.resume();
			}
		};
		const deliver = (text: string, stream: "stdout" | "stderr") => {
			if (!text || callbackError !== undefined || settled) return;
			try {
				options?.onOutput?.(text, context, { stream });
			} catch (error) {
				callbackError = toError(error);
				terminate(child);
			}
		};
		const write = async (chunk: Buffer) => {
			const stream = spill;
			if (stream === undefined || outputError) return;
			await new Promise<void>((accept, reject) => {
				stream.write(chunk, (error) => (error ? reject(error) : accept()));
			});
		};
		const retain = async (chunk: Buffer) => {
			if (options?.spill === undefined || outputError) return;
			bytes += chunk.length;
			for (const byte of chunk) if (byte === 10) newlines++;
			if (chunk.length) lastByte = chunk[chunk.length - 1];
			if (spill !== undefined) {
				await write(chunk);
				return;
			}
			prefix.push(chunk);
			if (
				bytes <= options.spill.afterBytes &&
				newlines + (lastByte !== undefined && lastByte !== 10 ? 1 : 0) <= options.spill.afterLines
			)
				return;
			const created = await host.createTempFile({ prefix: "axi-output-", suffix: ".log" }, context);
			if (!created.ok) throw created.error;
			spillPath = created.value;
			spill = createWriteStream(spillPath, { flags: "a", highWaterMark: 1024 * 1024 });
			spill.on("error", (error) => {
				outputError = error;
				terminate(child);
			});
			for (const part of prefix) await write(part);
			prefix = [];
		};
		const finish = async () => {
			if (settled || finishing) return;
			finishing = true;
			if (idleTimer !== undefined) clearTimeout(idleTimer);
			await queue;
			child.stdout.destroy();
			child.stderr.destroy();
			deliver(decoders.stdout.decode(), "stdout");
			deliver(decoders.stderr.decode(), "stderr");
			if (spill !== undefined) {
				const stream = spill;
				await new Promise<void>((accept) => {
					if (stream.destroyed) {
						accept();
						return;
					}
					stream.once("error", () => accept());
					stream.end(() => accept());
				});
			}
			settled = true;
			if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
			signal?.removeEventListener("abort", abort);
			host.processes.delete(child);
			let failure: ExecutionError | undefined;
			if (callbackError) failure = new ExecutionError("callback_error", callbackError.message, callbackError);
			else if (timedOut) failure = new ExecutionError("timeout", `timeout:${timeout}`);
			else if (signal?.aborted) failure = new ExecutionError("aborted", "aborted");
			else if (spawnError) failure = new ExecutionError("spawn_error", spawnError.message, spawnError);
			else if (outputError)
				failure = new ExecutionError(
					"unknown",
					`Failed to preserve complete shell output: ${outputError.message}`,
					outputError,
				);
			if (failure) {
				if (spillPath !== undefined && (failure.code === "timeout" || failure.code === "aborted"))
					failure.spillPath = spillPath;
				resolve(err(failure));
			} else resolve(ok({ exitCode: code, ...(spillPath === undefined ? {} : { spillPath }) }));
		};
		const idle = () => {
			if (!exited || settled || finishing) return;
			if (idleTimer !== undefined) clearTimeout(idleTimer);
			idleTimer = setTimeout(() => {
				if (pending) idle();
				else void finish();
			}, 100);
		};
		const receive = (chunk: Buffer, stream: "stdout" | "stderr") => {
			if (settled || finishing) return;
			deliver(decoders[stream].decode(chunk), stream);
			if (options?.spill !== undefined) {
				pending++;
				pause();
				queue = queue
					.then(() => retain(chunk))
					.catch((error: unknown) => {
						outputError = toError(error);
						terminate(child);
					})
					.then(() => {
						pending--;
						if (!pending) resume();
						idle();
					});
			}
			idle();
		};
		child.stdout.on("data", (chunk: Buffer) => receive(chunk, "stdout"));
		child.stderr.on("data", (chunk: Buffer) => receive(chunk, "stderr"));
		child.on("error", (error) => {
			spawnError = error;
			exited = true;
			void finish();
		});
		child.on("exit", (exitCode, killedBy) => {
			exited = true;
			code = exitCode ?? (killedBy ? 128 + constants.signals[killedBy] : 0);
			idle();
		});
		child.on("close", () => {
			exited = true;
			void finish();
		});
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		if (timeout !== undefined)
			timeoutTimer = setTimeout(() => {
				timedOut = true;
				terminate(child);
			}, timeout * 1000);
		child.stdin?.on("error", () => {});
		child.stdin?.end(stdinCommand);
	});
}
