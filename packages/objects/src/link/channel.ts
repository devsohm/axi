import type { Context } from "../context/index.ts";
import { PROTOCOL_VERSION } from "../data/internal.ts";
import type { Link } from "./link.ts";
import { checkMessage, type Codec, type Message } from "./message.ts";
import { objectsMetrics, type ObjectsMetrics } from "../telemetry.ts";

export interface ChannelHandler {
	opened(): void;
	message(message: Message): void | Promise<void>;
	closed(): void;
}
type ChannelOptions = {
	readonly codec: Codec;
	readonly incarnation: string;
	readonly calls: number;
	readonly trusted: boolean;
	readonly report: (error: unknown) => void;
	readonly metrics?: ObjectsMetrics;
};
type Connection =
	| { readonly kind: "greeting"; readonly outgoing: Uint8Array[] }
	| { readonly kind: "open"; readonly peer: string; readonly calls: number }
	| { readonly kind: "closed" };

export class Channel {
	#connection: Connection = { kind: "greeting", outgoing: [] };
	#pending: { readonly messages: Uint8Array[]; next: number } | undefined;
	#last = Date.now();
	#ping = false;
	readonly #hello: Uint8Array;
	readonly #link: Link;
	readonly #handler: ChannelHandler;
	readonly #options: ChannelOptions;
	readonly #context: Context;
	readonly #bytes: { add(value: number, attributes: { readonly direction: "sent" | "received" }): void };
	constructor(
		link: Link,
		handler: ChannelHandler,
		options: ChannelOptions,
		context: Context,
	) {
		this.#link = link;
		this.#handler = handler;
		this.#options = options;
		this.#context = context;
		this.#bytes = (options.metrics ?? objectsMetrics(context.telemetry.metrics)).counter("objects.link.bytes");
		this.#hello = options.codec.encode({
			kind: "hello",
			protocol: PROTOCOL_VERSION,
			incarnation: options.incarnation,
			calls: options.calls,
		});
	}
	get peer(): string {
		return this.#connection.kind === "open" ? this.#connection.peer : "";
	}
	get peerCalls(): number {
		return this.#connection.kind === "open" ? this.#connection.calls : 0;
	}
	get opened(): boolean {
		return this.#connection.kind === "open";
	}
	get closed(): boolean {
		return this.#connection.kind === "closed";
	}
	start(): void {
		this.#bytes.add(this.#hello.byteLength, { direction: "sent" });
		this.#link.send(this.#hello);
		this.#link.onMessage((bytes) => this.#receive(bytes));
		this.#link.onClose(() => {
			if (this.closed) return;
			this.#connection = { kind: "closed" };
			this.#pending = undefined;
			this.#handler.closed();
		});
	}
	send(message: Message): void {
		if (this.closed) return;
		const bytes = this.#options.codec.encode(message);
		this.#bytes.add(bytes.byteLength, { direction: "sent" });
		if (this.#connection.kind === "greeting")
			this.#connection.outgoing.push(bytes);
		else this.#link.send(bytes);
	}
	close(): void {
		this.#link.close();
	}
	tick(now: number, paused: number, ping: number, close: number): void {
		if (paused > 0) this.#last = Math.min(now - ping, this.#last + paused);
		const silence = now - this.#last;
		if (silence >= close) this.close();
		else if (this.opened && silence >= ping && !this.#ping) {
			this.#ping = true;
			this.#link.send(this.#options.codec.encode({ kind: "ping" }));
		}
	}
	#receive(bytes: Uint8Array): void {
		if (this.closed) return;
		this.#bytes.add(bytes.byteLength, { direction: "received" });
		this.#last = Date.now();
		this.#ping = false;
		if (this.#pending) this.#pending.messages.push(bytes);
		else {
			const handling = this.#dispatch(bytes);
			if (handling) {
				this.#pending = { messages: [], next: 0 };
				this.#wait(handling);
			}
		}
	}
	#wait(handling: Promise<void>): void {
		handling.then(
			() => this.#drain(),
			(error: unknown) => this.#fail(error),
		);
	}
	#drain(): void {
		const queue = this.#pending;
		if (!queue) return;
		while (this.opened && queue.next < queue.messages.length) {
			const handling = this.#dispatch(queue.messages[queue.next++]!);
			if (handling) {
				queue.messages.splice(0, queue.next);
				queue.next = 0;
				this.#wait(handling);
				return;
			}
		}
		this.#pending = undefined;
	}
	#read(bytes: Uint8Array): Message {
		const value = this.#options.codec.decode(bytes);
		return this.#options.trusted ? value : checkMessage(value, this.#context);
	}
	#dispatch(bytes: Uint8Array): void | Promise<void> {
		try {
			if (this.#connection.kind === "greeting") {
				let greeting: Message;
				try {
					greeting = this.#read(bytes);
				} catch (cause) {
					throw new Error(
						`handshake: the first message is no ${this.#options.codec.name} message`,
						{ cause },
					);
				}
				if (greeting.kind !== "hello")
					throw new Error(`handshake: ${greeting.kind} before hello`);
				if (greeting.protocol !== PROTOCOL_VERSION)
					throw new Error(
						`handshake: protocol ${greeting.protocol}, this host speaks ${PROTOCOL_VERSION}`,
					);
				const queued = this.#connection.outgoing;
				this.#connection = {
					kind: "open",
					peer: greeting.incarnation,
					calls: greeting.calls,
				};
				for (const packet of queued) this.#link.send(packet);
				this.#handler.opened();
				return;
			}
			const message = this.#read(bytes);
			if (message.kind === "hello")
				throw new Error("handshake: a second hello");
			if (message.kind === "ping")
				this.#link.send(this.#options.codec.encode({ kind: "pong" }));
			else if (message.kind !== "pong") return this.#handler.message(message);
		} catch (error) {
			this.#fail(error);
		}
	}
	#fail(error: unknown): void {
		if (this.closed) return;
		this.#options.report(error);
		this.close();
	}
}
