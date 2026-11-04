export function nextDelay(previous: number | undefined): number {
	return previous === undefined ? 1_000 : Math.min(60_000, previous * 2);
}
type Window = {
	readonly delay: number;
	readonly until: number;
	timer: ReturnType<typeof setTimeout> | undefined;
};
export class Backoff {
	readonly #due: (identity: string) => void;
	readonly #windows = new Map<string, Window>();
	constructor(due: (identity: string) => void) {
		this.#due = due;
	}
	failed(identity: string): void {
		const previous = this.#windows.get(identity);
		clearTimeout(previous?.timer);
		const delay = nextDelay(previous?.delay),
			window: Window = { delay, until: Date.now() + delay, timer: undefined };
		window.timer = setTimeout(() => {
			window.timer = undefined;
			this.#due(identity);
		}, delay);
		this.#windows.set(identity, window);
	}
	waiting(identity: string): boolean {
		return this.#windows.get(identity)?.timer !== undefined;
	}
	until(identity: string): number | undefined {
		const window = this.#windows.get(identity);
		return window?.timer === undefined ? undefined : window.until;
	}
	skip(identity: string): void {
		const window = this.#windows.get(identity);
		if (window) {
			clearTimeout(window.timer);
			window.timer = undefined;
		}
	}
	ended(identity: string): void {
		if (!this.waiting(identity)) this.#windows.delete(identity);
	}
	delete(identity: string): void {
		clearTimeout(this.#windows.get(identity)?.timer);
		this.#windows.delete(identity);
	}
	clear(): void {
		for (const key of this.#windows.keys()) this.delete(key);
	}
}
