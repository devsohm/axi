import { type Link, LinkEnd } from "./link.ts";

export interface WebSocketLike {
	readonly readyState: number;
	binaryType: string;
	send(data: Uint8Array<ArrayBuffer>): void;
	close(): void;
	addEventListener(
		type: "open" | "close" | "error",
		listener: () => void,
	): void;
	addEventListener(
		type: "message",
		listener: (event: { readonly data: unknown }) => void,
	): void;
	removeEventListener(
		type: "open" | "close" | "error",
		listener: () => void,
	): void;
	removeEventListener(
		type: "message",
		listener: (event: { readonly data: unknown }) => void,
	): void;
}

class WebSocketEnd extends LinkEnd {
	#socket: WebSocketLike | undefined;
	#pending: Uint8Array[] | undefined;
	readonly #opened = (): void => {
		const pending = this.#pending ?? [];
		this.#pending = undefined;
		for (const message of pending) this.send(message);
	};
	readonly #received = (event: { readonly data: unknown }): void => {
		if (event.data instanceof ArrayBuffer)
			this.deliver(new Uint8Array(event.data));
		else this.close();
	};
	readonly #failed = (): void => this.#detach();
	constructor(socket: WebSocketLike) {
		super();
		if (socket.readyState !== 0 && socket.readyState !== 1) {
			this.ended();
			return;
		}
		this.#socket = socket;
		socket.binaryType = "arraybuffer";
		if (socket.readyState === 0) {
			this.#pending = [];
			socket.addEventListener("open", this.#opened);
		}
		socket.addEventListener("message", this.#received);
		const closed = () => {
			socket.removeEventListener("error", this.#failed);
			socket.removeEventListener("close", closed);
			this.#detach();
		};
		socket.addEventListener("close", closed);
		socket.addEventListener("error", this.#failed);
	}
	send(message: Uint8Array): void {
		if (!this.#socket) return;
		if (this.#pending) {
			this.#pending.push(message);
			return;
		}
		try {
			this.#socket.send(message as Uint8Array<ArrayBuffer>);
		} catch {
			this.close();
		}
	}
	close(): void {
		const socket = this.#socket;
		if (!socket) return;
		this.#detach();
		socket.close();
	}
	#detach(): void {
		const socket = this.#socket;
		if (!socket) return;
		this.#socket = undefined;
		this.#pending = undefined;
		socket.removeEventListener("message", this.#received);
		socket.removeEventListener("open", this.#opened);
		this.ended();
	}
}
export function webSocketLink(socket: WebSocketLike): Link {
	return new WebSocketEnd(socket);
}
