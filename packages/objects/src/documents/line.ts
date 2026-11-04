export class Line {
	#pending = Promise.resolve();
	acquire(): Promise<() => void> {
		let release!: () => void;
		const next = new Promise<void>((resolve) => {
			release = resolve;
		});
		const previous = this.#pending;
		this.#pending = next;
		return previous.then(() => release);
	}
}
