import { terminalColor, type Theme, type ColorDepth } from "../surfaces/index.ts";
export class TerminalTheme {
	readonly #depth: ColorDepth;
	#theme: Theme;
	readonly #listeners = new Set<() => void>();
	constructor(theme: Theme, depth: ColorDepth) {
		this.#theme = theme;
		this.#depth = depth;
	}
	get theme(): Theme {
		return this.#theme;
	}
	fg(role: string, text: string): string {
		return `\x1b[${terminalColor(this.#theme, role, this.#depth, "fg")}m${text}\x1b[39m`;
	}
	bg(role: string, text: string): string {
		return `\x1b[${terminalColor(this.#theme, role, this.#depth, "bg")}m${text}\x1b[49m`;
	}
	onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}
	set(theme: Theme): void {
		this.#theme = theme;
		for (const listener of this.#listeners) listener();
	}
}
