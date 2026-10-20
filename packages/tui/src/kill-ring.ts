export class KillRing {
	#entries: string[] = [];

	get length(): number {
		return this.#entries.length;
	}

	peek(): string | undefined {
		return this.#entries.at(-1);
	}

	push(text: string, options: { prepend: boolean; accumulate?: boolean }): void {
		if (text.length === 0) return;
		const previous = this.peek();
		if (options.accumulate && previous !== undefined) {
			this.#entries[this.#entries.length - 1] = options.prepend ? text + previous : previous + text;
			return;
		}
		this.#entries.push(text);
	}

	rotate(): void {
		if (this.#entries.length < 2) return;
		this.#entries = this.#entries.slice(-1).concat(this.#entries.slice(0, -1));
	}
}
