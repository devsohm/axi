import { Terminal as Emulator } from "@xterm/headless";
import type { Terminal } from "../../src/terminal.ts";

export class TestTerminal implements Terminal {
	readonly emulator: Emulator;
	columns: number;
	rows: number;
	kittyProtocolActive = false;
	#input?: (data: string) => void;
	#resize?: () => void;
	#pending: Promise<void>[] = [];
	constructor(columns = 40, rows = 10) {
		this.columns = columns;
		this.rows = rows;
		this.emulator = new Emulator({ cols: columns, rows, allowProposedApi: true });
	}
	start(input: (data: string) => void, resize: () => void): void {
		this.#input = input;
		this.#resize = resize;
	}
	stop(): void {
		this.#input = undefined;
		this.#resize = undefined;
	}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.#pending.push(new Promise((resolve) => this.emulator.write(data, resolve)));
	}
	input(data: string): void {
		this.#input?.(data);
	}
	resize(columns: number, rows: number): void {
		this.columns = columns;
		this.rows = rows;
		this.emulator.resize(columns, rows);
		this.#resize?.();
	}
	async screen(): Promise<string[]> {
		while (this.#pending.length) await Promise.all(this.#pending.splice(0));
		const buffer = this.emulator.buffer.active;
		return Array.from(
			{ length: this.rows },
			(_, row) =>
				buffer
					.getLine(buffer.viewportY + row)
					?.translateToString(true)
					.trimEnd() ?? "",
		);
	}
	moveBy(lines: number): void {
		if (lines) this.write(`\x1b[${Math.abs(lines)}${lines < 0 ? "A" : "B"}`);
	}
	hideCursor(): void {
		this.write("\x1b[?25l");
	}
	showCursor(): void {
		this.write("\x1b[?25h");
	}
	clearLine(): void {
		this.write("\x1b[2K");
	}
	clearFromCursor(): void {
		this.write("\x1b[J");
	}
	clearScreen(): void {
		this.write("\x1b[2J\x1b[H");
	}
	setTitle(title: string): void {
		this.write(`\x1b]0;${title}\x07`);
	}
	setProgress(): void {}
	setProgramStatus(): void {}
	dispose(): void {
		this.stop();
		this.emulator.dispose();
	}
}
