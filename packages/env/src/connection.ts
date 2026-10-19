import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

export type Json = Record<string, unknown>;
export class RemoteError extends Error {
	readonly code: string;
	readonly path?: string;
	readonly fields: Json;
	constructor(fields: Json) {
		super(typeof fields.message === "string" ? fields.message : "Remote operation failed");
		this.name = "RemoteError";
		this.code = typeof fields.code === "string" ? fields.code : "unknown";
		if (typeof fields.path === "string") this.path = fields.path;
		this.fields = fields;
	}
}
export interface RemoteInfo {
	protocol: number;
	version: string;
	os: string;
	arch: string;
	home: string;
	tmpdir: string;
	separator: string;
	cwd: string;
	driveCwds: Record<string, string>;
	pid: number;
	features?: string[];
}
export function nodePlatform(info: Pick<RemoteInfo, "os" | "arch">): { platform: string; arch: string } {
	const platforms: Record<string, string> = { windows: "win32", macos: "darwin" },
		architectures: Record<string, string> = { x86_64: "x64", aarch64: "arm64", x86: "ia32" };
	return { platform: platforms[info.os] ?? info.os, arch: architectures[info.arch] ?? info.arch };
}
export interface ConnectionOptions {
	command: readonly string[] | (() => Promise<readonly string[]>);
	onLog?: (text: string) => void;
}
export interface Reply {
	json: Json;
	payload: Uint8Array;
	session: number;
}
export interface RequestOptions {
	payload?: Uint8Array;
	signal?: AbortSignal;
	onEvent?: (json: Json, payload: Uint8Array) => void;
	onStart?: (id: number, session: number) => void;
	session?: number;
}
type Pending = { resolve(value: Reply): void; reject(error: Error): void; onEvent?: RequestOptions["onEvent"] };
const lost = (message: string) => new RemoteError({ code: "unknown", message, lost: true });
const closed = () => new RemoteError({ code: "unknown", message: "Connection closed" });
export const isConnectionLost = (error: unknown): boolean => error instanceof RemoteError && error.fields.lost === true;

function wellFormed(_key: string, value: unknown): unknown {
	return typeof value === "string" ? value.toWellFormed() : value;
}
function encode(type: number, id: number, json: Json, payload: Uint8Array = new Uint8Array(0)): Buffer {
	const body = Buffer.from(JSON.stringify(json, wellFormed), "utf8");
	const header = Buffer.alloc(13);
	header.writeUInt32BE(9 + body.length + payload.length, 0);
	header.writeUInt8(type, 4);
	header.writeUInt32BE(id, 5);
	header.writeUInt32BE(body.length, 9);
	return Buffer.concat([header, body, payload]);
}
class DaemonSession {
	readonly id: number;
	readonly child: ChildProcessWithoutNullStreams;
	readonly token: string;
	readonly pending = new Map<number, Pending>();
	chunks: Buffer[] = [];
	buffered = 0;
	synced = false;
	live = true;
	lastSeen = Date.now();
	timer: ReturnType<typeof setInterval> | undefined;
	constructor(id: number, child: ChildProcessWithoutNullStreams, token: string) {
		this.id = id;
		this.child = child;
		this.token = token;
	}
	peek(length: number): Buffer {
		if (this.chunks[0]!.length < length) this.chunks = [Buffer.concat(this.chunks)];
		return this.chunks[0]!.subarray(0, length);
	}
	consume(length: number): void {
		this.buffered -= length;
		while (length > 0) {
			const chunk = this.chunks[0]!;
			if (chunk.length <= length) {
				length -= chunk.length;
				this.chunks.shift();
			} else {
				this.chunks[0] = chunk.subarray(length);
				length = 0;
			}
		}
	}
}

export class Connection {
	readonly #options: ConnectionOptions;
	#current: DaemonSession | undefined;
	#ready: Promise<{ info: RemoteInfo; session: DaemonSession }> | undefined;
	#sessionId = 0;
	#requestId = 1;
	#closed = false;
	constructor(options: ConnectionOptions) {
		this.#options = options;
	}
	async info(): Promise<RemoteInfo> {
		return (await this.#connect()).info;
	}
	async session(): Promise<number> {
		return (await this.#connect()).session.id;
	}
	async request(op: string, json: Json, options: RequestOptions = {}): Promise<Reply> {
		if (options.session !== undefined) {
			const current = this.#current;
			if (!current?.live || current.id !== options.session) throw lost("Axi environment connection lost");
			return this.#send(current, op, json, options);
		}
		return this.#send((await this.#connect()).session, op, json, options);
	}
	close(): void {
		this.#closed = true;
		if (this.#current) this.#stop(this.#current, closed());
	}
	kill(id: number, session: number): void {
		const current = this.#current;
		if (current?.live && current.id === session) this.#write(current, encode(5, id, { mode: "kill" }));
	}
	#connect(): Promise<{ info: RemoteInfo; session: DaemonSession }> {
		if (this.#closed) return Promise.reject(closed());
		if (!this.#ready) {
			const ready = this.#start();
			this.#ready = ready;
			void ready.catch(() => {
				if (this.#ready === ready) this.#ready = undefined;
			});
		}
		return this.#ready;
	}
	#send(session: DaemonSession, op: string, json: Json, options: RequestOptions): Promise<Reply> {
		if (!session.live) return Promise.reject(lost("Axi environment connection lost"));
		const id = this.#requestId++;
		return new Promise((resolve, reject) => {
			const cancel = () => this.#write(session, encode(5, id, {}));
			const detach = () => options.signal?.removeEventListener("abort", cancel);
			session.pending.set(id, {
				resolve: (value) => {
					detach();
					resolve(value);
				},
				reject: (error) => {
					detach();
					reject(error);
				},
				...(options.onEvent ? { onEvent: options.onEvent } : {}),
			});
			options.signal?.addEventListener("abort", cancel, { once: true });
			options.onStart?.(id, session.id);
			this.#write(session, encode(1, id, { ...json, op }, options.payload));
			if (options.signal?.aborted) cancel();
		});
	}
	#write(session: DaemonSession, bytes: Buffer): void {
		if (session.live) session.child.stdin.write(bytes);
	}
	async #start(): Promise<{ info: RemoteInfo; session: DaemonSession }> {
		let command: readonly string[];
		try {
			const option = this.#options.command;
			command = typeof option === "function" ? await option() : option;
		} catch (error) {
			throw new RemoteError({
				code: "spawn_error",
				message: error instanceof Error ? error.message : String(error),
				lost: true,
			});
		}
		if (this.#closed) throw closed();
		const [program, ...args] = command;
		if (program === undefined) throw new RemoteError({ code: "spawn_error", message: "No daemon command" });
		const token = randomBytes(16).toString("hex");
		const child = spawn(program, [...args, "serve", "--token", token], { stdio: ["pipe", "pipe", "pipe"] });
		const session = new DaemonSession(++this.#sessionId, child, token);
		this.#current = session;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const startup = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => reject(lost("Axi environment did not answer within 60 s")), 60000);
			child.once("error", (error) =>
				reject(new RemoteError({ code: "spawn_error", message: error.message, lost: true })),
			);
			child.once("exit", (code) => reject(lost(`Axi environment exited with code ${code} before it was ready`)));
		});
		void startup.catch(() => {});
		child.stdout.on("data", (bytes: Buffer) => this.#receive(session, bytes));
		child.stderr.on("data", (bytes: Buffer) => this.#options.onLog?.(bytes.toString("utf8")));
		child.on("error", () => this.#stop(session, lost("Axi environment connection lost")));
		child.on("exit", () => this.#stop(session, lost("Axi environment connection lost")));
		child.stdin.on("error", () => {});
		session.timer = setInterval(() => {
			this.#write(session, encode(6, 0, {}));
			if (Date.now() - session.lastSeen > 30000) this.#stop(session, lost("Axi environment connection timed out"));
		}, 5000);
		session.timer.unref();
		try {
			const reply = await Promise.race([this.#send(session, "hello", { protocol: 1 }, {}), startup]);
			if (reply.json.protocol !== 1) throw lost(`Unsupported protocol ${reply.json.protocol}`);
			return { info: reply.json as unknown as RemoteInfo, session };
		} catch (error) {
			this.#stop(session, error instanceof Error ? error : lost(String(error)));
			throw error;
		} finally {
			clearTimeout(timer);
		}
	}
	#stop(session: DaemonSession, error: Error): void {
		if (!session.live) return;
		session.live = false;
		clearInterval(session.timer);
		if (this.#current === session) {
			this.#current = undefined;
			this.#ready = undefined;
		}
		session.child.stdin.end();
		session.child.kill();
		const pending = [...session.pending.values()];
		session.pending.clear();
		for (const request of pending) request.reject(error);
	}
	#receive(session: DaemonSession, bytes: Buffer): void {
		if (!session.live) return;
		session.lastSeen = Date.now();
		session.chunks.push(bytes);
		session.buffered += bytes.length;
		if (!session.synced) {
			const marker = Buffer.from(`AXI-ENV ${session.token}\n`);
			const received = session.peek(session.buffered),
				offset = received.indexOf(marker);
			if (offset < 0) {
				if (session.buffered > 1048576) session.consume(session.buffered - marker.length);
				return;
			}
			const noise = received.subarray(0, offset).toString("utf8").trim();
			if (noise) this.#options.onLog?.(noise);
			session.consume(offset + marker.length);
			session.synced = true;
		}
		while (session.live && session.buffered >= 4) {
			const length = session.peek(4).readUInt32BE();
			if (length < 9 || length > 16 * 1024 * 1024) {
				this.#stop(session, lost("Corrupt frame from Axi environment"));
				return;
			}
			if (session.buffered < length + 4) return;
			const body = session.peek(length + 4).subarray(4),
				type = body[0]!,
				id = body.readUInt32BE(1),
				jsonLength = body.readUInt32BE(5);
			let json: Json;
			try {
				if (jsonLength + 9 > length) throw new Error("JSON length out of range");
				const parsed: unknown = JSON.parse(body.subarray(9, jsonLength + 9).toString("utf8"));
				if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
				json = parsed as Json;
			} catch {
				this.#stop(session, lost("Corrupt frame from Axi environment"));
				return;
			}
			const payload = new Uint8Array(body.subarray(jsonLength + 9));
			session.consume(length + 4);
			const pending = session.pending.get(id);
			if (type === 4) pending?.onEvent?.(json, payload);
			else if ((type === 2 || type === 3) && pending) {
				session.pending.delete(id);
				if (type === 2) pending.resolve({ json, payload, session: session.id });
				else pending.reject(new RemoteError(json));
			}
		}
	}
}
