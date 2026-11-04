import type { BridgeRequest, LauncherMessage, SandboxMessage } from "../../tui/bridge.ts";
export const MAX_PIPE_FRAME = 17 * 1024 * 1024;
function encode(header: object, bytes?: Uint8Array): Buffer {
	const json = Buffer.from(JSON.stringify(header)),
		prefix = Buffer.allocUnsafe(8);
	prefix.writeUInt32BE(4 + json.length + (bytes?.length ?? 0));
	prefix.writeUInt32BE(json.length, 4);
	return Buffer.concat(bytes ? [prefix, json, bytes] : [prefix, json]);
}
export function startFrame(start: unknown, source: string): Buffer {
	return encode({ kind: "start", start }, Buffer.from(source));
}
export function launcherFrame(message: LauncherMessage): Buffer {
	if (message.kind === "input") return encode({ kind: message.kind }, Buffer.from(message.data));
	if (message.kind === "socket_message") return encode({ kind: message.kind, socket: message.socket }, message.bytes);
	if (message.kind === "attached")
		return encode({ kind: message.kind, id: message.id, name: message.name }, message.bytes);
	return encode(message);
}
function malformed(): Error {
	return new Error("terminal: the sandbox sent a malformed message");
}
function request(raw: unknown): BridgeRequest {
	if (!raw || typeof raw !== "object") throw malformed();
	const kind = Reflect.get(raw, "kind");
	if (kind === "base") return { kind };
	const field =
		kind === "fetch" || kind === "attach" ? "path" : kind === "copy" ? "text" : kind === "open" ? "url" : undefined;
	if (!field) throw malformed();
	const value: unknown = Reflect.get(raw, field);
	if (typeof value !== "string") throw malformed();
	switch (kind) {
		case "fetch":
		case "attach":
			return { kind, path: value };
		case "copy":
			return { kind, text: value };
		case "open":
			return { kind, url: value };
		default:
			throw malformed();
	}
}
function decode(payload: Buffer): SandboxMessage {
	const length = payload.readUInt32BE(0);
	if (length > 1024 * 1024 || length + 4 > payload.length) throw malformed();
	const header: unknown = JSON.parse(payload.toString("utf8", 4, length + 4)),
		body = payload.subarray(length + 4);
	if (!header || typeof header !== "object") throw malformed();
	const value = header as Record<string, unknown>,
		socket = value.socket;
	switch (value.kind) {
		case "write":
			return { kind: "write", data: body.toString("utf8") };
		case "socket_send":
		case "socket_open":
		case "socket_close":
			if (typeof socket !== "number" || !Number.isSafeInteger(socket)) throw malformed();
			return value.kind === "socket_send"
				? { kind: value.kind, socket, bytes: new Uint8Array(body) }
				: { kind: value.kind, socket };
		case "request":
			if (typeof value.id !== "number" || !Number.isSafeInteger(value.id)) throw malformed();
			return { kind: "request", id: value.id, request: request(value.request) };
		case "outdated":
			return { kind: "outdated" };
		case "failed":
			return { kind: "failed", message: String(value.message) };
		case "exit":
			return {
				kind: "exit",
				code: typeof value.code === "number" && Number.isSafeInteger(value.code) ? value.code : 1,
			};
		default:
			throw malformed();
	}
}
export class FrameReader {
	#buffer = Buffer.alloc(65536);
	#read = 0;
	#write = 0;
	push(chunk: Buffer): SandboxMessage[] {
		const unread = this.#write - this.#read;
		if (this.#write + chunk.length > this.#buffer.length) {
			const capacity = unread + chunk.length,
				next =
					capacity <= this.#buffer.length
						? this.#buffer
						: Buffer.alloc(Math.max(capacity, Math.min(this.#buffer.length * 2, MAX_PIPE_FRAME + 4)));
			this.#buffer.copy(next, 0, this.#read, this.#write);
			this.#buffer = next;
			this.#read = 0;
			this.#write = unread;
		}
		chunk.copy(this.#buffer, this.#write);
		this.#write += chunk.length;
		const messages: SandboxMessage[] = [];
		while (this.#write - this.#read >= 4) {
			const size = this.#buffer.readUInt32BE(this.#read);
			if (size < 4 || size > MAX_PIPE_FRAME) throw new Error("terminal: the sandbox sent a malformed frame");
			if (this.#write - this.#read < size + 4) break;
			messages.push(decode(this.#buffer.subarray(this.#read + 4, this.#read + 4 + size)));
			this.#read += size + 4;
		}
		if (this.#read === this.#write) this.#read = this.#write = 0;
		return messages;
	}
}
