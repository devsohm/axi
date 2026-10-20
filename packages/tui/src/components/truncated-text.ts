import type { Component } from "../tui.ts";
import { truncateToWidth, visibleWidth } from "../utils.ts";

export class TruncatedText implements Component {
	readonly #text: string;
	readonly #paddingX: number;
	readonly #paddingY: number;
	constructor(text: string, paddingX = 0, paddingY = 0) {
		this.#text = text;
		this.#paddingX = paddingX;
		this.#paddingY = paddingY;
	}
	invalidate(): void {}
	render(width: number): string[] {
		const margin = " ".repeat(this.#paddingX);
		const content =
			margin + truncateToWidth(this.#text.split("\n", 1)[0], Math.max(1, width - 2 * this.#paddingX)) + margin;
		const blank: string[] = [];
		for (let index = 0; index < this.#paddingY; index++) blank.push(" ".repeat(width));
		return [...blank, content + " ".repeat(Math.max(0, width - visibleWidth(content))), ...blank];
	}
}
