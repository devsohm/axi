import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { unlinkSync } from "node:fs";
import { lstat, mkdir, rm } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChordError } from "./errors.ts";
import { type IpcLink, ipcLink } from "./link.ts";

export type ControlMessage =
	| { readonly type: "init"; readonly value: unknown }
	| { readonly type: "ready" }
	| { readonly type: "fatal"; readonly message: string; readonly reason?: string }
	| { readonly type: "shutdown" }
	| {
			readonly type: "status";
			readonly activeCalls?: number;
			readonly viewers?: number;
			readonly durableTasks?: number;
	  };
export interface Liveness {
	readonly booting: boolean;
	readonly activeCalls: number;
	readonly viewers: number;
	readonly durableTasks: number;
	readonly idleFor: number;
}
export interface Exit {
	readonly code: number | null;
	readonly signal: string | null;
}
export interface Instance {
	readonly pid: number;
	readonly link: IpcLink;
	readonly exited: Promise<Exit>;
	send(message: ControlMessage): void;
	killTree(): void;
	onControl(listener: (message: ControlMessage) => void): void;
}
export interface Driver {
	spawn(): Instance;
}
export interface ForkDriverOptions {
	readonly entry: string;
	readonly args?: readonly string[];
	readonly env?: Readonly<Record<string, string>>;
	readonly execArgv?: readonly string[];
	readonly init?: unknown;
	readonly lock?: string;
	readonly onOutput?: (stream: "stdout" | "stderr", chunk: Uint8Array) => void;
	readonly onMessage?: (message: unknown) => void;
}

async function socketPath(filename: string): Promise<string> {
	const path = join(tmpdir(), filename);
	if (Buffer.byteLength(path) <= 103) return path;
	const uid = process.getuid?.() ?? 0,
		directory = `/tmp/chord2-${uid}`;
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const stat = await lstat(directory);
	if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o077) !== 0)
		throw new ChordError("unavailable", `lock directory ${directory} must be a directory only its owner can access`);
	return join(directory, filename);
}
function occupied(path: string): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = connect(path);
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", (error: NodeJS.ErrnoException) =>
			resolve(error.code !== "ECONNREFUSED" && error.code !== "ENOENT"),
		);
	});
}
export async function processLock(name: string): Promise<() => Promise<void>> {
	const digest = createHash("sha256").update(name).digest("hex").slice(0, 32);
	const filesystem = process.platform !== "win32" && process.platform !== "linux" && process.platform !== "android";
	const address =
		process.platform === "win32"
			? `\\\\.\\pipe\\chord2-${digest}`
			: filesystem
				? await socketPath(`chord2-${digest}.sock`)
				: `\0chord2-${digest}`;
	const server = createServer((socket) => socket.end());
	while (true) {
		try {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(address, () => {
					server.off("error", reject);
					resolve();
				});
			});
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
			if (!filesystem || (await occupied(address)))
				throw new ChordError("unavailable", `lock ${name} is held by another process`, { reason: "locked" });
			await rm(address, { force: true });
		}
	}
	const remove = (): void => {
		try {
			unlinkSync(address);
		} catch {
			/* The socket may already be unlinked. */
		}
	};
	if (filesystem) process.once("exit", remove);
	return () =>
		new Promise<void>((resolve, reject) => {
			if (filesystem) process.off("exit", remove);
			server.close((error) => (error ? reject(error) : resolve()));
		});
}

const lockEnv = "CHORD2_LOCK";
const droppedSend = (): void => {};
export function forkDriver(options: ForkDriverOptions): Driver {
	return {
		spawn() {
			const env = { ...process.env };
			delete env[lockEnv];
			Object.assign(env, options.env);
			if (options.lock !== undefined) env[lockEnv] = options.lock;
			const child = fork(options.entry, [...(options.args ?? [])], {
				env,
				execArgv: [...(options.execArgv ?? [])],
				detached: true,
				stdio: ["ignore", options.onOutput ? "pipe" : "inherit", options.onOutput ? "pipe" : "inherit", "ipc"],
			});
			if (options.onOutput)
				for (const stream of ["stdout", "stderr"] as const)
					child[stream]?.on("data", (chunk: Buffer) => {
						options.onOutput!(stream, chunk);
						process[stream].write(chunk);
					});
			const pid = child.pid ?? -1;
			const killGroup = (): boolean => {
				try {
					process.kill(-pid, "SIGKILL");
					return true;
				} catch {
					return false;
				}
			};
			const exited = new Promise<Exit>((resolve) =>
				child.once("exit", (code, signal) => {
					killGroup();
					resolve({ code, signal });
				}),
			);
			const listeners = new Set<(message: ControlMessage) => void>();
			child.on("message", (message) => {
				options.onMessage?.(message);
				const control = (message as { chord2control?: ControlMessage } | null)?.chord2control;
				if (control !== undefined) for (const listener of listeners) listener(control);
			});
			const send = (message: ControlMessage): void => {
				if (child.connected) child.send({ chord2control: message }, droppedSend);
			};
			if (options.init !== undefined) send({ type: "init", value: options.init });
			return {
				pid,
				link: ipcLink(child),
				exited,
				send,
				killTree() {
					if (!killGroup()) child.kill("SIGKILL");
				},
				onControl(listener) {
					return listeners.add(listener);
				},
			};
		},
	};
}

export interface HostManagerOptions {
	readonly driver: Driver;
	readonly keepAlive?: (liveness: Liveness) => boolean;
	readonly checkInterval?: number;
	readonly grace?: number;
	readonly readyTimeout?: number;
	readonly onExit?: (exit: Exit) => void;
}
export interface HostManager {
	readonly status: "stopped" | "starting" | "running" | "stopping";
	readonly instance: Instance | undefined;
	readonly liveness: Liveness;
	start(): Promise<Instance>;
	stop(): Promise<void>;
	replace(): Promise<Instance>;
}
export function createHostManager(options: HostManagerOptions): HostManager {
	let phase: HostManager["status"] = "stopped",
		current: Instance | undefined;
	let tail: Promise<unknown> = Promise.resolve(),
		booting = false;
	let counts = { activeCalls: 0, viewers: 0, durableTasks: 0 };
	let idleSince: number | undefined, interval: ReturnType<typeof setInterval> | undefined;
	const liveness = (): Liveness => ({
		booting,
		...counts,
		idleFor: idleSince === undefined ? 0 : Date.now() - idleSince,
	});
	function serialize<T>(step: () => Promise<T>): Promise<T> {
		const next = tail.then(step, step);
		tail = next.catch(() => {});
		return next;
	}
	async function stop(): Promise<void> {
		const instance = current;
		if (!instance) {
			phase = "stopped";
			booting = false;
			return;
		}
		phase = "stopping";
		clearInterval(interval);
		instance.send({ type: "shutdown" });
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const graceful = await Promise.race([
			instance.exited.then(() => true),
			new Promise<boolean>((resolve) => {
				timeout = setTimeout(() => resolve(false), options.grace ?? 5000);
			}),
		]);
		clearTimeout(timeout);
		if (!graceful) instance.killTree();
		await instance.exited;
		if (current === instance) current = undefined;
		phase = "stopped";
	}
	async function start(): Promise<Instance> {
		if (current && phase === "running") return current;
		phase = "starting";
		booting = true;
		counts = { activeCalls: 0, viewers: 0, durableTasks: 0 };
		let instance: Instance;
		try {
			instance = options.driver.spawn();
		} catch (error) {
			phase = "stopped";
			booting = false;
			throw error;
		}
		current = instance;
		instance.exited.then((exit) => {
			if (current === instance) {
				current = undefined;
				phase = "stopped";
				clearInterval(interval);
			}
			options.onExit?.(exit);
		});
		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(
				() => reject(new ChordError("unavailable", "child not ready in time")),
				options.readyTimeout ?? 30000,
			);
			const settle = (complete: () => void): void => {
				clearTimeout(timeout);
				complete();
			};
			instance.exited.then((exit) =>
				settle(() => reject(new ChordError("unavailable", `child exited before ready (${exit.code ?? exit.signal})`))),
			);
			instance.onControl((message) => {
				if (message.type === "ready") settle(resolve);
				else if (message.type === "fatal")
					settle(() =>
						reject(new ChordError("unavailable", `child failed: ${message.message}`, { reason: message.reason })),
					);
				else if (message.type === "status") {
					counts = {
						activeCalls: message.activeCalls ?? 0,
						viewers: message.viewers ?? 0,
						durableTasks: message.durableTasks ?? 0,
					};
					if (counts.activeCalls + counts.viewers + counts.durableTasks > 0) idleSince = undefined;
					else idleSince ??= Date.now();
				}
			});
		}).catch(async (error: unknown) => {
			instance.killTree();
			await instance.exited;
			throw error;
		});
		booting = false;
		if (counts.activeCalls + counts.viewers + counts.durableTasks === 0) idleSince ??= Date.now();
		phase = "running";
		if (options.keepAlive !== undefined) {
			const keep = options.keepAlive;
			interval = setInterval(() => {
				if (phase === "running" && !keep(liveness())) void serialize(stop);
			}, options.checkInterval ?? 1000);
			interval.unref?.();
		}
		return instance;
	}
	return {
		get status() {
			return phase;
		},
		get instance() {
			return current;
		},
		get liveness() {
			return liveness();
		},
		start: () => serialize(start),
		stop: () => serialize(stop),
		replace: () =>
			serialize(async () => {
				await stop();
				return start();
			}),
	};
}

export function childControl(channel: NodeJS.Process = process): {
	readonly init: Promise<unknown>;
	lock(): Promise<void>;
	ready(): void;
	fatal(error: unknown): void;
	report(status: { activeCalls?: number; viewers?: number; durableTasks?: number }): void;
	onShutdown(handler: () => void | Promise<void>): void;
} {
	const send = (message: ControlMessage): void => {
		if (channel.connected) channel.send?.({ chord2control: message }, undefined, undefined, droppedSend);
	};
	let resolveInit: (value: unknown) => void = () => {};
	const init = new Promise<unknown>((resolve) => {
		resolveInit = resolve;
	});
	const handlers = new Set<() => void | Promise<void>>();
	channel.on("message", (message: unknown) => {
		const control = (message as { chord2control?: ControlMessage } | null)?.chord2control;
		if (control?.type === "init") resolveInit(control.value);
		if (control?.type === "shutdown") for (const handler of handlers) void handler();
	});
	const fatal = (error: unknown): void =>
		send({
			type: "fatal",
			message: error instanceof Error ? error.message : String(error),
			...(error instanceof ChordError && error.reason !== undefined ? { reason: error.reason } : {}),
		});
	return {
		init,
		async lock() {
			const name = process.env[lockEnv];
			if (name === undefined) return;
			try {
				await processLock(name);
			} catch (error) {
				fatal(error);
				throw error;
			}
		},
		ready: () => send({ type: "ready" }),
		fatal,
		report: (status) => send({ type: "status", ...status }),
		onShutdown(handler) {
			return handlers.add(handler);
		},
	};
}
