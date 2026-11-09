import { createHash } from "node:crypto";
import { unlinkSync } from "node:fs";
import { lstat, mkdir, unlink } from "node:fs/promises";
import { connect, createServer, type Socket, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "../../context/index.ts";
export type ProcessLock = { release(): Promise<void> };
export type LockAddress = { readonly kind: "abstract" | "pipe" | "file"; readonly address: string };
export async function processLock(name: string, context: Context): Promise<ProcessLock> {
	return lockAt(await lockAddress(name), context);
}
export async function clearStaleLock(name: string, context: Context): Promise<boolean> {
	return clearStaleLockAt(await lockAddress(name), context);
}
async function lockAddress(name: string): Promise<LockAddress> {
	const digest = createHash("sha256").update(name).digest("hex").slice(0, 32);
	if (process.platform === "win32")
		return { kind: "pipe", address: String.raw`\\.\pipe\objects-lock-${digest}` };
	if (process.platform === "linux" || process.platform === "android")
		return { kind: "abstract", address: `\0objects-lock-${digest}` };
	const file = `objects-lock-${digest}.sock`;
	let path = join(tmpdir(), file);
	if (Buffer.byteLength(path) > 103) {
		const owner = process.getuid?.() ?? 0,
			directory = `/tmp/objects-lock-${owner}`;
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const stats = await lstat(directory);
		if (!stats.isDirectory() || stats.uid !== owner || stats.mode & 0o077)
			throw new Error(`lock directory ${directory} must be a directory only its owner can access`);
		path = join(directory, file);
	}
	return { kind: "file", address: path };
}
export async function clearStaleLockAt(lock: LockAddress, context: Context): Promise<boolean> {
	context.abortSignal?.throwIfAborted();
	if (lock.kind !== "file") return false;
	const stale = await new Promise<boolean>((resolve) => {
		const socket = connect(lock.address);
		socket.once("connect", () => { socket.destroy(); resolve(false); });
		socket.once("error", (error: NodeJS.ErrnoException) => resolve(error.code === "ECONNREFUSED" || error.code === "ENOTSOCK"));
	});
	if (!stale) return false;
	try { await unlink(lock.address); return true; }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
export async function lockAt(lock: LockAddress, context: Context): Promise<ProcessLock> {
	const clients = new Set<Socket>();
	const server = createServer((socket) => {
		clients.add(socket);
		socket.on("error", () => {});
		socket.once("close", () => clients.delete(socket));
	});
	while (true) {
		context.abortSignal?.throwIfAborted();
		if (await listen(server, lock.address)) break;
		const occupied = await wait(lock.address, context);
		if (!occupied && lock.kind === "file")
			throw new Error(`lock: ${lock.address} is a stale lock file (no process holds it); remove it if no worker runs`);
	}
	const remove = (): void => {
		try {
			unlinkSync(lock.address);
		} catch {}
	};
	if (lock.kind === "file") process.once("exit", remove);
	return {
		release: () =>
			new Promise<void>((resolve, reject) => {
				if (lock.kind === "file") process.removeListener("exit", remove);
				server.close((error) => (error ? reject(error) : resolve()));
				for (const socket of clients) socket.destroy();
			}),
	};
}
function listen(server: Server, path: string): Promise<boolean> {
	return new Promise((resolve, reject) => {
		const failed = (error: NodeJS.ErrnoException): void => {
			if (error.code === "EADDRINUSE") resolve(false);
			else reject(error);
		};
		server.once("error", failed);
		server.listen(path, () => {
			server.removeListener("error", failed);
			resolve(true);
		});
	});
}
function wait(path: string, context: Context): Promise<boolean> {
	return new Promise((resolve, reject) => {
		const signal = context.abortSignal;
		if (signal?.aborted) {
			reject(signal.reason);
			return;
		}
		const socket = connect(path);
		let connected = false;
		const abort = (): void => {
			socket.destroy();
			reject(signal?.reason);
		};
		const done = (occupied: boolean): void => {
			signal?.removeEventListener("abort", abort);
			resolve(occupied);
		};
		signal?.addEventListener("abort", abort, { once: true });
		socket.once("connect", () => {
			connected = true;
		});
		socket.on("error", (error: NodeJS.ErrnoException) => {
			if (!connected && (error.code === "ECONNREFUSED" || error.code === "ENOTSOCK")) done(false);
		});
		socket.once("close", () => done(true));
	});
}
