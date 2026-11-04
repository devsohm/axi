import type { SandboxChannel } from "./channel.ts";
export class BridgeTerminal {
	readonly #channel: SandboxChannel;
	#columns: number;
	#rows: number;
	constructor(channel: SandboxChannel) {
		this.#channel = channel;
		this.#columns = channel.start.columns;
		this.#rows = channel.start.rows;
		channel.onResize((columns, rows) => {
			this.#columns = columns;
			this.#rows = rows;
		});
	}
	get columns(): number {
		return this.#columns;
	}
	get rows(): number {
		return this.#rows;
	}
	write(data: string): void {
		this.#channel.write(data);
	}
	onInput(listener: (data: string) => void): () => void {
		return this.#channel.onInput(listener);
	}
	onResize(listener: () => void): () => void {
		return this.#channel.onResize(listener);
	}
}
