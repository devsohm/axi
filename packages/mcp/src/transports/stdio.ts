import { spawn, type ChildProcess } from "node:child_process";
import crossSpawn from "cross-spawn";
import { McpConnectionClosedError, parseJsonRpcMessage, type JsonRpcMessage } from "../protocol/jsonrpc.ts";
import { DEFAULT_MAX_MESSAGE_BYTES, TransportEvents, type McpTransport } from "./transport.ts";
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
	child.once("exit", () => {
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
	#out = Buffer.alloc(0);
	#err = Buffer.alloc(0);
	#started = false;
	#closed = false;
	constructor(options: StdioTransportOptions) {
		super();
		this.options = Object.freeze({ ...options, args: options.args ? [...options.args] : undefined });
	}
	get pid(): number | undefined {
		return this.#child?.pid;
	}
	get stderr(): string {
		return this.#err.toString("utf8");
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
		child.stdout?.on("data", (value: Buffer | string) => this.#stdout(value));
		child.stdout?.on("error", (error) => this.emitError(error));
		child.stdin?.on("error", (error) => {
			if (!this.#closed) this.emitError(error);
		});
		child.stderr?.on("error", (error) => this.emitError(error));
		child.stderr?.on("data", (value: Buffer | string) => {
			const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value),
				limit = this.options.maxStderrBytes ?? 65536;
			this.#err = Buffer.concat([this.#err, bytes]);
			if (this.#err.length > limit) this.#err = this.#err.subarray(-limit);
			this.options.onStderr?.(bytes.toString("utf8"));
		});
		child.on("close", () => {
			this.#child = undefined;
			if (this.#out.toString("utf8").trim())
				this.emitError(new Error("MCP stdio server closed with an incomplete JSON-RPC message"));
			this.#out = Buffer.alloc(0);
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
	#stdout(value: Buffer | string): void {
		this.#out = Buffer.concat([this.#out, Buffer.isBuffer(value) ? value : Buffer.from(value)]);
		const limit = this.options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
		for (;;) {
			const end = this.#out.indexOf(10);
			if (end < 0) {
				if (this.#out.length > limit) {
					this.#out = Buffer.alloc(0);
					this.emitError(new Error(`MCP stdio message exceeds ${limit} bytes`));
				}
				return;
			}
			const line = this.#out.subarray(0, end);
			this.#out = this.#out.subarray(end + 1);
			if (line.length > limit) {
				this.emitError(new Error(`MCP stdio message exceeds ${limit} bytes`));
				continue;
			}
			const text = line.toString("utf8").replace(/\r$/, "");
			if (!text.trim()) continue;
			try {
				this.emitMessage(parseJsonRpcMessage(JSON.parse(text)));
			} catch (error) {
				this.emitError(error);
			}
		}
	}
	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		const child = this.#child;
		if (!child) {
			this.emitClose();
			return;
		}
		if (child.exitCode !== null || child.signalCode !== null) {
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
