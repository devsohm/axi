export interface Link {
	send(message: Uint8Array): void;
	onMessage(listener: (message: Uint8Array) => void): void;
	close(): void;
	onClose(listener: () => void): void;
}

export abstract class LinkEnd implements Link {
	#closed = false;
	#receive: ((message: Uint8Array) => void) | undefined;
	#close: (() => void) | undefined;
	#pending: Uint8Array[] = [];
	abstract send(message: Uint8Array): void;
	abstract close(): void;
	get closed(): boolean {
		return this.#closed;
	}
	onMessage(listener: (message: Uint8Array) => void): void {
		if (this.#closed) return;
		this.#receive = listener;
		const messages = this.#pending;
		this.#pending = [];
		for (const message of messages) {
			if (this.#closed) break;
			listener(message);
		}
	}
	onClose(listener: () => void): void {
		if (this.#closed) listener();
		else this.#close = listener;
	}
	protected deliver(message: Uint8Array): void {
		if (this.#closed) return;
		if (this.#receive) this.#receive(message);
		else this.#pending.push(message);
	}
	protected ended(): void {
		if (this.#closed) return;
		this.#closed = true;
		const notify = this.#close;
		this.#close = undefined;
		this.#receive = undefined;
		this.#pending = [];
		notify?.();
	}
}

class MemoryEnd extends LinkEnd {
	peer: MemoryEnd | undefined;
	send(message: Uint8Array): void {
		if (this.closed) return;
		const peer = this.peer!;
		queueMicrotask(() => peer.deliver(message));
	}
	close(): void {
		if (this.closed) return;
		const peer = this.peer!;
		this.#end();
		queueMicrotask(() => peer.#end());
	}
	#end(): void {
		this.peer = undefined;
		this.ended();
	}
}
export function memoryLinkPair(): [Link, Link] {
	const first = new MemoryEnd(),
		second = new MemoryEnd();
	first.peer = second;
	second.peer = first;
	return [first, second];
}
