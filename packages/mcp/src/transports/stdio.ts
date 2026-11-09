import { spawn, type ChildProcess } from "node:child_process";
import crossSpawn from "cross-spawn";
import { McpConnectionClosedError, type JsonRpcMessage } from "../protocol/jsonrpc.ts";
import { TransportEvents, type McpTransport } from "./transport.ts";
import { JsonRpcLineReader } from "./lines.ts";
const groups = new Set<number>();
const useGroups = process.platform !== "win32";
let exitHook = false;
function kill(child: ChildProcess, signal: NodeJS.Signals): void {
	if (process.platform === "win32" && child.pid !== undefined) {
		if (child.exitCode === null)
			spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on(
				"error",
				() => {},
			);
		return;
	}
	if (useGroups && child.pid !== undefined) {
		try {
			process.kill(-child.pid, signal);
			return;
		} catch {}
	}
	try {
		child.kill(signal);
	} catch {}
}
function track(child: ChildProcess): void {
	if (!useGroups || child.pid === undefined) return;
	if (!exitHook) {
		exitHook = true;
		process.once("exit", () => {
			for (const pid of groups) {
				try {
					process.kill(-pid, "SIGTERM");
				} catch {}
			}
		});
	}
	const pid = child.pid;
	groups.add(pid);
	child.once("close", () => {
		groups.delete(pid);
	});
}
export interface StdioTransportOptions {
	command: string;
	args?: readonly string[];
	cwd?: string;
	env?: Record<string, string>;
	inheritEnv?: boolean;
	stderr?: "pipe" | "inherit";
	onStderr?: (chunk: string) => void;
	maxMessageBytes?: number;
	maxStderrBytes?: number;
	closeTimeoutMs?: number;
}
export class StdioTransport extends TransportEvents implements McpTransport {
	readonly options: Readonly<StdioTransportOptions>;
	#child?: ChildProcess;
	readonly #lines: JsonRpcLineReader;
	#started = false;
	#closed = false;
	constructor(options: StdioTransportOptions) {
		super();
		this.options = Object.freeze({ ...options, args: options.args ? [...options.args] : undefined });
		this.#lines = new JsonRpcLineReader({
			...this.options,
			onMessage: (message) => this.emitMessage(message),
			onError: (error) => this.emitError(error),
		});
	}
	get pid(): number | undefined {
		return this.#child?.pid;
	}
	get stderr(): string {
		return this.#lines.stderr;
	}
	async start(): Promise<void> {
		if (this.#started) throw new Error("MCP stdio transport already started");
		if (this.#closed) throw new McpConnectionClosedError();
		this.#started = true;
		const child = crossSpawn(this.options.command, this.options.args ?? [], {
			cwd: this.options.cwd,
			env: { ...(this.options.inheritEnv === false ? {} : process.env), ...this.options.env },
			stdio: ["pipe", "pipe", this.options.stderr === "inherit" ? "inherit" : "pipe"],
			windowsHide: true,
			detached: useGroups,
		});
		this.#child = child;
		track(child);
		child.stdout?.on("data", (value: Buffer | string) =>
			this.#lines.readStdout(typeof value === "string" ? Buffer.from(value) : value),
		);
		child.stdout?.on("error", (error) => this.emitError(error));
		child.stdin?.on("error", (error) => {
			if (!this.#closed) this.emitError(error);
		});
		child.stderr?.on("error", (error) => this.emitError(error));
		child.stderr?.on("data", (value: Buffer | string) =>
			this.#lines.readStderr(typeof value === "string" ? Buffer.from(value) : value),
		);
		child.on("close", () => {
			this.#child = undefined;
			this.#lines.end();
			this.emitClose();
		});
		await new Promise<void>((resolve, reject) => {
			const error = (value: Error) => {
				child.off("spawn", ready);
				reject(value);
			};
			const ready = () => {
				child.off("error", error);
				resolve();
			};
			child.once("error", error);
			child.once("spawn", ready);
		});
		child.on("error", (error) => {
			if (!this.#closed) this.emitError(error);
		});
	}
	async send(message: JsonRpcMessage): Promise<void> {
		const input = this.#child?.stdin;
		if (!this.#started || this.#closed || !input?.writable) throw new McpConnectionClosedError();
		const payload = JSON.stringify(message) + "\n";
		await new Promise<void>((resolve, reject) => input.write(payload, (error) => (error ? reject(error) : resolve())));
	}
	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		const child = this.#child;
		if (!child) {
			this.emitClose();
			return;
		}
		if (!useGroups && (child.exitCode !== null || child.signalCode !== null)) {
			child.stdin?.end();
			return;
		}
		const timeout = this.options.closeTimeoutMs ?? 2000;
		await new Promise<void>((resolve) => {
			const timers: ReturnType<typeof setTimeout>[] = [];
			child.once("close", () => {
				for (const timer of timers) clearTimeout(timer);
				kill(child, "SIGTERM");
				resolve();
			});
			const grace = Math.min(500, timeout);
			timers.push(setTimeout(() => kill(child, "SIGTERM"), grace));
			timers.push(setTimeout(() => kill(child, "SIGKILL"), grace + timeout));
			child.stdin?.end();
		});
	}
}
