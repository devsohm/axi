import { LinkEnd } from "../link/link.ts";
import type { Bridge, BridgeRequest, BridgeStart, LauncherMessage } from "./bridge.ts";
import { splitFrames } from "./frames.ts";
export type RelayEvents = { opened(): void; received(): void };
export class SandboxChannel {
	readonly #bridge: Bridge;
	readonly #pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
	readonly #links = new Map<number, RelayLink>();
	readonly #input = new Set<(data: string) => void>();
	readonly #resize = new Set<(columns: number, rows: number) => void>();
	#id = 0;
	constructor(bridge: Bridge) {
		this.#bridge = bridge;
		bridge.onMessage((event) => this.#receive(event));
	}
	get start(): BridgeStart {
		return this.#bridge.start;
	}
	request(request: BridgeRequest): Promise<unknown> {
		const id = ++this.#id;
		return new Promise((resolve, reject) => {
			this.#pending.set(id, { resolve, reject });
			this.#bridge.send({ kind: "request", id, request });
		});
	}
	evaluate(text: string, filename: string): void {
		this.#bridge.evaluate(text, filename);
	}
	write(data: string): void {
		for (const frame of splitFrames(data)) this.#bridge.send({ kind: "write", data: frame });
	}
	outdated(): void {
		this.#bridge.send({ kind: "outdated" });
	}
	exit(code: number): void {
		this.#bridge.send({ kind: "exit", code });
	}
	onInput(listener: (data: string) => void): () => void {
		this.#input.add(listener);
		return () => {
			this.#input.delete(listener);
		};
	}
	onResize(listener: (columns: number, rows: number) => void): () => void {
		this.#resize.add(listener);
		return () => {
			this.#resize.delete(listener);
		};
	}
	openSocket(events: RelayEvents): RelayLink {
		const id = ++this.#id,
			link = new RelayLink(id, events, this.#bridge, () => {
				this.#links.delete(id);
			});
		this.#links.set(id, link);
		this.#bridge.send({ kind: "socket_open", socket: id });
		return link;
	}
	#receive(message: LauncherMessage): void {
		switch (message.kind) {
			case "input":
				for (const listener of this.#input) listener(message.data);
				break;
			case "resize":
				for (const listener of this.#resize) listener(message.columns, message.rows);
				break;
			case "socket_opened":
				this.#links.get(message.socket)?.opened();
				break;
			case "socket_message":
				this.#links.get(message.socket)?.received(message.bytes);
				break;
			case "socket_closed":
				this.#links.get(message.socket)?.dropped();
				break;
			default: {
				const pending = this.#pending.get(message.id);
				this.#pending.delete(message.id);
				if (message.kind === "refused") pending?.reject(new Error(message.message));
				else pending?.resolve(message.kind === "reply" ? message.value : { name: message.name, bytes: message.bytes });
			}
		}
	}
}
export class RelayLink extends LinkEnd {
	readonly #id: number;
	readonly #events: RelayEvents;
	readonly #bridge: Bridge;
	readonly #forget: () => void;
	#queue: Uint8Array[] | undefined = [];
	constructor(socket: number, events: RelayEvents, bridge: Bridge, forget: () => void) {
		super();
		this.#id = socket;
		this.#events = events;
		this.#bridge = bridge;
		this.#forget = forget;
	}
	send(bytes: Uint8Array): void {
		if (!this.closed) {
			if (this.#queue) this.#queue.push(bytes);
			else this.#bridge.send({ kind: "socket_send", socket: this.#id, bytes });
		}
	}
	close(): void {
		if (!this.closed) {
			this.#bridge.send({ kind: "socket_close", socket: this.#id });
			this.dropped();
		}
	}
	opened(): void {
		const queue = this.#queue ?? [];
		this.#queue = undefined;
		this.#events.opened();
		for (const bytes of queue) this.send(bytes);
	}
	received(bytes: Uint8Array): void {
		this.#events.received();
		this.deliver(bytes);
	}
	dropped(): void {
		this.#forget();
		this.ended();
	}
}
