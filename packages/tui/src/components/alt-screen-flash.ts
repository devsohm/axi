import type { Component } from "../tui.ts";
import { truncateToWidth } from "../utils.ts";
export class AltScreenFlashContainer implements Component {
	readonly #entries = new Map<number, { message: string; timer: ReturnType<typeof setTimeout> }>();
	#next = 0;
	readonly #redraw: () => void;
	constructor(requestRender: () => void) {
		this.#redraw = requestRender;
	}
	flash(message: string, durationMs = 1000): void {
		const id = this.#next++,
			timer = setTimeout(
				() => {
					if (this.#entries.delete(id)) this.#redraw();
				},
				Math.max(0, durationMs),
			);
		timer.unref();
		this.#entries.set(id, { message, timer });
		this.#redraw();
	}
	dispose(): void {
		for (const entry of this.#entries.values()) clearTimeout(entry.timer);
		this.#entries.clear();
	}
	invalidate(): void {}
	render(width: number): string[] {
		return [...this.#entries.values()].map(
			(entry) => `\x1b[7m${truncateToWidth(` ${entry.message} `, width, "")}\x1b[27m`,
		);
	}
}
