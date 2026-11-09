export class Deadline {
	readonly #expired: () => void;
	#remaining: number;
	#started = 0;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#cleared = false;
	constructor(ms: number, expired: () => void) {
		this.#remaining = ms;
		this.#expired = expired;
		this.resume();
	}
	pause(): void {
		if (this.#timer === undefined) return;
		clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#remaining = Math.max(0, this.#remaining - (Date.now() - this.#started));
	}
	resume(): void {
		if (this.#timer !== undefined || this.#cleared) return;
		this.#started = Date.now();
		this.#timer = setTimeout(this.#expired, this.#remaining);
	}
	clear(): void {
		clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#cleared = true;
	}
}
