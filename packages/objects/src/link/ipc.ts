import { type Link, LinkEnd } from "./link.ts";

export interface IpcPort {
	send(message: Uint8Array, callback: (error: Error | null) => void): boolean;
	on(event: "message", listener: (message: unknown) => void): unknown;
	on(event: "disconnect", listener: () => void): unknown;
	removeListener(event: "message", listener: (message: unknown) => void): unknown;
	removeListener(event: "disconnect", listener: () => void): unknown;
	disconnect(): void;
	readonly connected: boolean;
}

class IpcEnd extends LinkEnd {
	#port: IpcPort | undefined;
	readonly #receive = (message: unknown): void => {
		if (message instanceof Uint8Array) this.deliver(message);
	};
	readonly #disconnected = (): void => this.#detach();
	readonly #sent = (error: Error | null): void => {
		if (error !== null) this.#detach();
	};
	constructor(port: IpcPort) {
		super();
		this.#port = port;
		if (!port.connected) {
			this.#detach();
			return;
		}
		port.on("message", this.#receive);
		port.on("disconnect", this.#disconnected);
	}
	send(message: Uint8Array): void {
		try {
			this.#port?.send(message, this.#sent);
		} catch {
			this.#detach();
		}
	}
	close(): void {
		const port = this.#port;
		if (!port) return;
		this.#detach();
		if (port.connected) port.disconnect();
	}
	#detach(): void {
		const port = this.#port;
		this.#port = undefined;
		port?.removeListener("message", this.#receive);
		port?.removeListener("disconnect", this.#disconnected);
		this.ended();
	}
}
export function ipcLink(port: IpcPort): Link {
	return new IpcEnd(port);
}
