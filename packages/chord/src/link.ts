import type * as Zlib from "node:zlib";
import type { Frame } from "./wire.ts";

export interface Link {
	readonly closed: boolean;
	send(frame: Frame): number | undefined;
	receive(handler: (frame: Frame) => void): void;
	onClose(handler: (reason: string) => void): void;
	close(reason?: string): void;
}

abstract class Channel implements Link {
	#closed = false;
	#receiver: ((frame: Frame) => void) | undefined;
	#buffer: Frame[] = [];
	readonly #listeners = new Set<(reason: string) => void>();
	#decoding: Promise<void> | undefined;
	get closed(): boolean {
		return this.#closed;
	}
	protected abstract transmit(frame: Frame): number | undefined;
	protected abstract shutdown(): void;
	send(frame: Frame): number | undefined {
		return this.#closed ? undefined : this.transmit(frame);
	}
	receive(handler: (frame: Frame) => void): void {
		this.#receiver = handler;
		for (const frame of this.#buffer.splice(0)) handler(frame);
	}
	onClose(handler: (reason: string) => void): void {
		if (this.#closed) handler("closed");
		else this.#listeners.add(handler);
	}
	close(reason = "closed"): void {
		if (this.#closed) return;
		try {
			this.transmit({ t: "bye", reason });
		} catch {
			/* A disconnected transport cannot send its final frame. */
		}
		this.ended(reason);
	}
	protected ended(reason: string): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#buffer = [];
		try {
			this.shutdown();
		} finally {
			for (const listener of this.#listeners) listener(reason);
			this.#listeners.clear();
		}
	}
	protected deliver(frame: Frame): void {
		if (this.#decoding) this.deliverLater(Promise.resolve(frame));
		else this.#dispatch(frame);
	}
	protected deliverLater(decoded: Promise<Frame>): void {
		const tail = (this.#decoding ?? Promise.resolve())
			.then(() => decoded)
			.then(
				(frame) => this.#dispatch(frame),
				() => this.close("protocol error"),
			)
			.finally(() => {
				if (this.#decoding === tail) this.#decoding = undefined;
			});
		this.#decoding = tail;
	}
	#dispatch(frame: Frame): void {
		if (this.#closed) return;
		if (frame.t === "bye") this.ended(frame.reason ?? "peer closed");
		else if (this.#receiver) this.#receiver(frame);
		else this.#buffer.push(frame);
	}
}

export const PACK_THRESHOLD = 65536;
const zlib = (
	globalThis as { process?: { getBuiltinModule?(id: "node:zlib"): typeof Zlib } }
).process?.getBuiltinModule?.("node:zlib");
export class Packed {
	readonly bytes: Uint8Array;
	constructor(bytes: Uint8Array) {
		this.bytes = bytes;
	}
}
export function unpack(value: unknown): unknown {
	if (!(value instanceof Packed)) return value;
	if (!zlib) throw new TypeError("packed payload without zlib");
	return JSON.parse(zlib.inflateRawSync(value.bytes).toString("utf8"));
}
type Field = "args" | "value";
const fields: ReadonlySet<string> = new Set(["args", "value"]);
const isField = (value: unknown): value is Field => typeof value === "string" && fields.has(value);
function payload(frame: Frame): Field | undefined {
	if (frame.t === "call") return frame.args === undefined ? undefined : "args";
	if ((frame.t === "result" || frame.t === "state") && frame.value !== undefined) return "value";
	return undefined;
}
function envelope(frame: Frame, field: Field): Record<string, unknown> {
	const result: Record<string, unknown> = { ...frame };
	delete result[field];
	return result;
}
function compress(value: unknown, enabled: boolean, json?: string): Uint8Array | undefined {
	if (value instanceof Packed) return value.bytes;
	if (enabled && zlib && json !== undefined && json.length > PACK_THRESHOLD)
		return zlib.deflateRawSync(json, { level: 1 });
	return undefined;
}
function objectFrame(frame: Frame): unknown {
	const field = payload(frame);
	if (!field) return frame;
	const value = Reflect.get(frame, field);
	const bytes = compress(value, true, zlib ? JSON.stringify(value) : undefined);
	return bytes
		? {
				...envelope(frame, field),
				z: [field, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64")],
			}
		: frame;
}
function readObject(value: unknown): unknown {
	if (value === null || typeof value !== "object" || !("z" in value)) return value;
	const { z, ...rest } = value;
	if (!Array.isArray(z) || !isField(z[0]) || typeof z[1] !== "string") throw new TypeError("bad packed payload");
	return { ...rest, [z[0]]: new Packed(Buffer.from(z[1], "base64")) };
}
function parse(text: string): Frame {
	const value = readObject(JSON.parse(text));
	if (value === null || typeof value !== "object" || typeof (value as Frame).t !== "string")
		throw new TypeError("not a frame");
	return value as Frame;
}
const utf8 = new TextEncoder();
const text = new TextDecoder();
function message(frame: Frame, enabled: boolean): string | Uint8Array {
	const field = payload(frame);
	if (!field) return JSON.stringify(frame);
	const value = Reflect.get(frame, field),
		json = value instanceof Packed ? undefined : JSON.stringify(value);
	const bytes = compress(value, enabled, json),
		head = envelope(frame, field);
	if (!bytes) return `${JSON.stringify(head).slice(0, -1)},${JSON.stringify(field)}:${json}}`;
	const encoded = utf8.encode(JSON.stringify({ ...head, z: field }));
	const packet = new Uint8Array(encoded.byteLength + bytes.byteLength + 4);
	new DataView(packet.buffer).setUint32(0, encoded.byteLength);
	packet.set(encoded, 4);
	packet.set(bytes, encoded.byteLength + 4);
	return packet;
}
function split(data: Uint8Array): { head: Record<string, unknown>; field: Field; bytes: Uint8Array } {
	const length = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0);
	const head: unknown = JSON.parse(text.decode(data.subarray(4, length + 4)));
	if (head === null || typeof head !== "object") throw new TypeError("bad envelope");
	const { z, ...rest } = head as Record<string, unknown>;
	if (!isField(z)) throw new TypeError("bad packed payload");
	return { head: rest, field: z, bytes: data.slice(length + 4) };
}
export function inflateMessage(data: Uint8Array): string {
	if (!zlib) throw new TypeError("inflateMessage needs zlib");
	const { head, field, bytes } = split(data);
	return `${JSON.stringify(head).slice(0, -1)},${JSON.stringify(field)}:${zlib.inflateRawSync(bytes).toString("utf8")}}`;
}
async function inflate(bytes: Uint8Array): Promise<unknown> {
	const stream = new Blob([bytes as Uint8Array<ArrayBuffer>])
		.stream()
		.pipeThrough(new DecompressionStream("deflate-raw"));
	return JSON.parse(await new Response(stream).text());
}

export class MemoryLink extends Channel {
	peer: MemoryLink | undefined;
	#broken = false;
	#tail = Promise.resolve();
	sever(): void {
		this.#broken = true;
		if (this.peer) this.peer.#broken = true;
	}
	protected transmit(frame: Frame): number | undefined {
		if (this.#broken) return undefined;
		const encoded = JSON.stringify(objectFrame(frame)),
			peer = this.peer;
		this.#tail = this.#tail.then(() => {
			if (!this.#broken && peer) peer.deliver(parse(encoded));
		});
		return encoded.length;
	}
	protected shutdown(): void {
		const peer = this.peer;
		this.#tail = this.#tail.then(() => peer?.ended("peer closed"));
	}
}
export function memoryLinkPair(): [MemoryLink, MemoryLink] {
	const left = new MemoryLink(),
		right = new MemoryLink();
	left.peer = right;
	right.peer = left;
	return [left, right];
}

export interface IpcChannel {
	readonly connected: boolean;
	send(message: unknown, callback?: (error: Error | null) => void): boolean;
	on(event: "message", listener: (message: unknown) => void): unknown;
	on(event: "disconnect", listener: () => void): unknown;
	off(event: "message", listener: (message: unknown) => void): unknown;
	off(event: "disconnect", listener: () => void): unknown;
}
export class IpcLink extends Channel {
	readonly #channel: IpcChannel;
	readonly #message = (message: unknown): void => {
		const frame = (message as { chord2?: unknown } | null)?.chord2;
		if (frame === undefined) return;
		try {
			this.deliver(readObject(frame) as Frame);
		} catch {
			this.close("protocol error");
		}
	};
	readonly #disconnect = (): void => this.ended("ipc disconnected");
	readonly #sent = (error: Error | null): void => {
		if (error !== null) this.ended(`ipc send failed: ${(error as { code?: string }).code ?? error.message}`);
	};
	constructor(channel: IpcChannel) {
		super();
		this.#channel = channel;
		channel.on("message", this.#message);
		channel.on("disconnect", this.#disconnect);
	}
	protected transmit(frame: Frame): undefined {
		if (this.#channel.connected) this.#channel.send({ chord2: objectFrame(frame) }, this.#sent);
		return undefined;
	}
	protected shutdown(): void {
		this.#channel.off("message", this.#message);
		this.#channel.off("disconnect", this.#disconnect);
	}
}
export const ipcLink = (channel: IpcChannel): IpcLink => new IpcLink(channel);

export interface WebSocketLike {
	readonly readyState: number;
	send(data: string | Uint8Array): void;
	close(code?: number, reason?: string): void;
	addEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void;
	addEventListener(type: "open" | "close" | "error", listener: () => void): void;
}
export interface WebSocketLinkOptions {
	readonly compress?: boolean;
	readonly acceptPacked?: boolean;
}
export class WebSocketLink extends Channel {
	readonly #socket: WebSocketLike;
	readonly #compress: boolean;
	#outbox: (string | Uint8Array)[] = [];
	constructor(socket: WebSocketLike, options: WebSocketLinkOptions = {}) {
		super();
		this.#socket = socket;
		this.#compress = options.compress ?? false;
		const acceptPacked = options.acceptPacked ?? true;
		if ("binaryType" in socket) (socket as { binaryType: string }).binaryType = "arraybuffer";
		socket.addEventListener("open", () => {
			for (const packet of this.#outbox.splice(0)) socket.send(packet);
		});
		socket.addEventListener("message", (event) => {
			try {
				const value = event.data;
				if (typeof value === "string") {
					this.deliver(parse(value));
					return;
				}
				if (!acceptPacked) throw new TypeError("packed frames are not accepted");
				const bytes =
					value instanceof ArrayBuffer
						? new Uint8Array(value)
						: ArrayBuffer.isView(value)
							? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
							: undefined;
				if (!bytes) throw new TypeError("unknown message type");
				const { head, field, bytes: compressed } = split(bytes);
				if (zlib) this.deliver({ ...head, [field]: new Packed(compressed) } as Frame);
				else this.deliverLater(inflate(compressed).then((value) => ({ ...head, [field]: value }) as Frame));
			} catch {
				this.close("protocol error");
			}
		});
		socket.addEventListener("close", () => this.ended("socket closed"));
	}
	protected transmit(frame: Frame): number {
		const packet = message(frame, this.#compress);
		if (this.#socket.readyState === 1) this.#socket.send(packet);
		else this.#outbox.push(packet);
		return typeof packet === "string" ? packet.length : packet.byteLength;
	}
	protected shutdown(): void {
		this.#outbox = [];
		if (this.#socket.readyState <= 1) this.#socket.close(1000);
	}
}
export const webSocketLink = (socket: WebSocketLike, options?: WebSocketLinkOptions): WebSocketLink =>
	new WebSocketLink(socket, options);
