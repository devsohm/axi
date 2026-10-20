import type { Component } from "../tui.ts";
import { applyBackgroundToLine, flattenLines, wrapTextWithAnsi } from "../utils.ts";

export class Text implements Component {
	#text: string;
	#paddingX: number;
	readonly #paddingY: number;
	#background: ((text: string) => string) | undefined;
	#cache: { width: number; lines: string[] } | undefined;
	constructor(text = "", paddingX = 1, paddingY = 1, customBgFn?: (text: string) => string) {
		this.#text = text;
		this.#paddingX = paddingX;
		this.#paddingY = paddingY;
		this.#background = customBgFn;
	}
	setText(text: string): void {
		this.#text = text;
		this.#cache = undefined;
	}
	setCustomBgFn(background?: (text: string) => string): void {
		this.#background = background;
		this.#cache = undefined;
	}
	invalidate(): void {
		this.#cache = undefined;
	}
	setPaddingX(paddingX: number): void {
		this.#paddingX = paddingX;
		this.invalidate();
	}
	render(width: number): string[] {
		if (this.#cache?.width === width) return this.#cache.lines;
		let lines: string[] = [];
		if (this.#text.trim()) {
			const padding = Math.min(this.#paddingX, Math.max(0, Math.floor((width - 1) / 2)));
			const contentWidth = Math.max(1, width - 2 * padding);
			const margin = " ".repeat(padding);
			const background = this.#background ?? ((text: string) => text);
			const content = wrapTextWithAnsi(this.#text.replace(/\t/g, "   "), contentWidth).map((line) =>
				applyBackgroundToLine(margin + line + margin, width, background),
			);
			const blank: string[] = [];
			for (let index = 0; index < this.#paddingY; index++)
				blank.push(this.#background?.(" ".repeat(width)) ?? " ".repeat(width));
			lines = [...blank, ...content, ...blank];
			flattenLines(lines);
		}
		this.#cache = { width, lines };
		return lines;
	}
}
