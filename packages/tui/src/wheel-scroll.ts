export type WheelScrollLines = number | "auto";

export class WheelScrollAccelerator {
	#lines: WheelScrollLines;
	readonly #accelerate: boolean;
	#previous: { time: number; direction: number; gap?: number; fraction: number } | undefined;

	constructor(
		lines: WheelScrollLines = "auto",
		accelerate = !(
			process.platform === "darwin" &&
			process.env.SSH_CONNECTION === undefined &&
			process.env.SSH_CLIENT === undefined &&
			process.env.SSH_TTY === undefined
		),
	) {
		this.#lines = lines;
		this.#accelerate = accelerate;
	}
	setLines(lines: WheelScrollLines): void {
		this.#lines = lines;
		this.#previous = undefined;
	}
	next(direction: -1 | 1, now: number): number {
		if (this.#lines !== "auto") return Number.isFinite(this.#lines) ? Math.max(1, Math.floor(this.#lines)) : 1;
		if (!this.#accelerate) return 1;
		const previous = this.#previous;
		const gap = previous ? now - previous.time : Infinity;
		if (!previous || previous.direction !== direction || gap > 200) {
			this.#previous = { time: now, direction, fraction: 0 };
			return 1;
		}
		previous.time = now;
		if (gap < 5) return 1;
		previous.gap = previous.gap === undefined ? gap : (previous.gap + gap) / 2;
		const amount = Math.min(6, Math.max(1, 100 / previous.gap)) + previous.fraction;
		previous.fraction = amount - Math.floor(amount);
		return Math.floor(amount);
	}
}
