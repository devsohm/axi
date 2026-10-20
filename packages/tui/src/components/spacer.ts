import type { Component } from "../tui.ts";

export class Spacer implements Component {
	#lines: number;
	constructor(lines = 1) {
		this.#lines = lines;
	}
	setLines(lines: number): void {
		this.#lines = lines;
	}
	invalidate(): void {}
	render(_width: number): string[] {
		const output: string[] = [];
		for (let index = 0; index < this.#lines; index++) output.push("");
		return output;
	}
}
