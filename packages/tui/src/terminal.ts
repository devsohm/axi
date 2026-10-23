import { isNativeModifierPressed } from "./native-modifiers.ts";
import { getNativePlatformHelper } from "./native-platform.ts";
import { appendFileSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { setKittyProtocolActive } from "./keys.ts";
import { StdinBuffer } from "./stdin-buffer.ts";
import {
	formatProgramStatus,
	isProgramStatusReply,
	PROGRAM_STATUS_QUERY,
	type ProgramStatus,
} from "./program-status.ts";

export interface Terminal {
	start(onInput: (data: string) => void, onResize: () => void): void;
	stop(): void;
	restoreOnExit?(before: string, after: string): void;
	drainInput(maxMs?: number, idleMs?: number): Promise<void>;
	write(data: string): void;
	readonly columns: number;
	readonly rows: number;
	readonly kittyProtocolActive: boolean;
	moveBy(lines: number): void;
	hideCursor(): void;
	showCursor(): void;
	clearLine(): void;
	clearFromCursor(): void;
	clearScreen(): void;
	setTitle(title: string): void;
	setProgress(active: boolean): void;
	setProgramStatus(status: ProgramStatus): void;
}

export type KeyboardProtocolNegotiationSequence =
	| { type: "kitty-flags"; flags: number }
	| { type: "device-attributes" };
export function parseKeyboardProtocolNegotiationSequence(
	sequence: string,
): KeyboardProtocolNegotiationSequence | undefined {
	const flags = /^\x1b\[\?(\d+)u$/.exec(sequence);
	if (flags) return { type: "kitty-flags", flags: Number(flags[1]) };
	return /^\x1b\[\?[\d;]*c$/.test(sequence) ? { type: "device-attributes" } : undefined;
}
function isNegotiationPrefix(data: string): boolean {
	return data === "\x1b[" || /^\x1b\[\?[\d;]*$/.test(data);
}
export function isAppleTerminalSession(): boolean {
	return process.platform === "darwin" && process.env.TERM_PROGRAM === "Apple_Terminal";
}
export function normalizeNativeShiftEnterInput(data: string, detect: boolean, shifted: boolean): string {
	return detect && shifted && data === "\r" ? "\x1b[13;2u" : data;
}
export function normalizeAppleTerminalInput(data: string, appleTerminal: boolean, shifted: boolean): string {
	return normalizeNativeShiftEnterInput(data, appleTerminal, shifted);
}
export function resolveEscapeTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
	const configured = Number(env.AXI_TUI_ESC_TIMEOUT);
	return Number.isFinite(configured) && configured > 0 ? configured : env.SSH_CONNECTION || env.SSH_TTY ? 100 : 10;
}
export function refreshTerminalDimensions(): void {
	if (process.platform === "win32" || process.pid <= 0) return;
	try {
		process.kill(process.pid, "SIGWINCH");
	} catch {
		/* Dimension refresh is best effort on restricted hosts. */
	}
}

export class ProcessTerminal implements Terminal {
	private inputHandler: ((data: string) => void) | undefined;
	#resize: (() => void) | undefined;
	#reader: ((data: string) => void) | undefined;
	#buffer: StdinBuffer | undefined;
	#wasRaw = false;
	#kitty = false;
	#pushed = false;
	#otherKeys = false;
	#owedDeviceReplies = 0;
	#negotiation = "";
	#negotiationTimer: ReturnType<typeof setTimeout> | undefined;
	#progress: ReturnType<typeof setInterval> | undefined;
	#status: ProgramStatus | undefined;
	#statusSupported = false;
	#statusPending = false;
	readonly #log: string;

	constructor() {
		let log = process.env.AXI_TUI_WRITE_LOG ?? "";
		if (log) {
			try {
				if (statSync(log).isDirectory()) {
					const now = new Date();
					const date = [
						now.getFullYear(),
						String(now.getMonth() + 1).padStart(2, "0"),
						String(now.getDate()).padStart(2, "0"),
					].join("-");
					const time = [now.getHours(), now.getMinutes(), now.getSeconds()]
						.map((part) => String(part).padStart(2, "0"))
						.join("-");
					log = join(log, `tui-${date}_${time}-${process.pid}.log`);
				}
			} catch {
				/* A file target need not exist yet. */
			}
		}
		this.#log = log;
	}
	get columns(): number {
		return process.stdout.columns || Number(process.env.COLUMNS) || 80;
	}
	get rows(): number {
		return process.stdout.rows || Number(process.env.LINES) || 24;
	}
	get kittyProtocolActive(): boolean {
		return this.#kitty;
	}
	get modifyOtherKeysActive(): boolean {
		return this.#otherKeys;
	}

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.inputHandler = onInput;
		this.#resize = onResize;
		this.#wasRaw = process.stdin.isRaw || false;
		process.stdin.setRawMode?.(true);
		if (process.platform === "win32") {
			try {
				getNativePlatformHelper()?.enableVirtualTerminalInput?.();
			} catch {}
		}
		process.stdin.setEncoding("utf8");
		process.stdin.resume();
		process.stdout.write("\x1b[?2004h");
		process.stdout.on("resize", onResize);
		refreshTerminalDimensions();
		this.queryAndEnableKittyProtocol();
	}

	private queryAndEnableKittyProtocol(): void {
		this.#buffer = new StdinBuffer({ escapeTimeout: resolveEscapeTimeoutMs() });
		this.#buffer.on("data", (data) => this.#read(data));
		this.#buffer.on("paste", (text) => this.inputHandler?.(`\x1b[200~${text}\x1b[201~`));
		this.#reader = (data) => this.#buffer?.process(data);
		process.stdin.on("data", this.#reader);
		this.#pushed = true;
		this.#owedDeviceReplies++;
		this.#clearNegotiation();
		const override = process.env.AXI_PROGRAM_STATUS;
		this.#statusSupported = override === "1";
		this.#statusPending = override !== "1" && override !== "0";
		process.stdout.write("\x1b[>7u\x1b[?u" + (this.#statusPending ? PROGRAM_STATUS_QUERY : "") + "\x1b[c");
		if (this.#statusSupported && this.#status) process.stdout.write(formatProgramStatus(this.#status));
	}

	#forward(data: string): void {
		if (!this.inputHandler) return;
		const detect = data === "\r" && (isAppleTerminalSession() || process.platform === "win32");
		this.inputHandler(normalizeNativeShiftEnterInput(data, detect, detect && isNativeModifierPressed("shift")));
	}
	#clearNegotiation(): void {
		clearTimeout(this.#negotiationTimer);
		this.#negotiationTimer = undefined;
		this.#negotiation = "";
	}
	#flushNegotiation(): void {
		const pending = this.#negotiation;
		this.#clearNegotiation();
		if (pending) this.#forward(pending);
	}
	#read(data: string): void {
		if (isProgramStatusReply(data)) {
			if (this.#statusPending) {
				this.#statusPending = false;
				this.#statusSupported = true;
				if (this.#status) process.stdout.write(formatProgramStatus(this.#status));
			}
			return;
		}
		let combined = this.#negotiation + data;
		let response = parseKeyboardProtocolNegotiationSequence(combined);
		if (this.#negotiation && !response && !isNegotiationPrefix(combined)) {
			this.#flushNegotiation();
			combined = data;
			response = parseKeyboardProtocolNegotiationSequence(data);
		}
		if (response) {
			this.#clearNegotiation();
			if (response.type === "kitty-flags") {
				if (response.flags) {
					if (this.#otherKeys) process.stdout.write("\x1b[>4;0m");
					this.#otherKeys = false;
					this.#kitty = true;
					setKittyProtocolActive(true);
				} else this.#enableOtherKeys();
				return;
			}
			if (this.#owedDeviceReplies > 0) {
				this.#owedDeviceReplies--;
				if (this.#owedDeviceReplies === 0) this.#statusPending = false;
				if (!this.#kitty) this.#enableOtherKeys();
				return;
			}
			this.#forward(combined);
			return;
		}
		if (isNegotiationPrefix(combined)) {
			clearTimeout(this.#negotiationTimer);
			this.#negotiation = combined;
			this.#negotiationTimer = setTimeout(() => this.#flushNegotiation(), 150);
			return;
		}
		this.#flushNegotiation();
		this.#forward(data);
	}
	#enableOtherKeys(): void {
		if (this.#kitty || this.#otherKeys) return;
		process.stdout.write("\x1b[>4;2m");
		this.#otherKeys = true;
	}
	#disableKeyboard(): void {
		this.#clearNegotiation();
		if (this.#pushed || this.#kitty) {
			process.stdout.write("\x1b[<u");
			this.#pushed = false;
			this.#kitty = false;
			setKittyProtocolActive(false);
		}
		if (this.#otherKeys) process.stdout.write("\x1b[>4;0m");
		this.#otherKeys = false;
	}

	async drainInput(maxMs = 1000, idleMs = 50): Promise<void> {
		this.#disableKeyboard();
		const handler = this.inputHandler;
		this.inputHandler = undefined;
		let last = Date.now();
		const observe = (): void => {
			last = Date.now();
		};
		process.stdin.on("data", observe);
		const end = last + maxMs;
		try {
			while (Date.now() < end && Date.now() - last < idleMs) await delay(Math.min(idleMs, end - Date.now()));
		} finally {
			process.stdin.removeListener("data", observe);
			this.inputHandler = handler;
		}
	}
	stop(): void {
		if (this.#progress) {
			clearInterval(this.#progress);
			this.#progress = undefined;
			process.stdout.write("\x1b]9;4;0\x07");
		}
		if (this.#statusSupported && this.#status) process.stdout.write(formatProgramStatus({ state: "clear" }));
		this.#statusSupported = false;
		this.#statusPending = false;
		process.stdout.write("\x1b[?2004l");
		this.#disableKeyboard();
		this.#buffer?.destroy();
		this.#buffer = undefined;
		if (this.#reader) process.stdin.removeListener("data", this.#reader);
		if (this.#resize) process.stdout.removeListener("resize", this.#resize);
		this.#reader = undefined;
		this.#resize = undefined;
		this.inputHandler = undefined;
		process.stdin.pause();
		process.stdin.setRawMode?.(this.#wasRaw);
	}
	restoreOnExit(before: string, after: string): void {
		const sequence =
			before +
			(this.#progress ? "\x1b]9;4;0\x07" : "") +
			"\x1b[?2004l" +
			(this.#pushed || this.#kitty ? "\x1b[<u" : "") +
			(this.#otherKeys ? "\x1b[>4;0m" : "") +
			after;
		try {
			writeSync(process.stdout.fd, sequence);
		} catch {}
	}
	write(data: string): void {
		process.stdout.write(data);
		if (this.#log) {
			try {
				appendFileSync(this.#log, data, "utf8");
			} catch {
				/* Diagnostic output must not interrupt rendering. */
			}
		}
	}
	moveBy(lines: number): void {
		if (lines) process.stdout.write(`\x1b[${Math.abs(lines)}${lines < 0 ? "A" : "B"}`);
	}
	hideCursor(): void {
		process.stdout.write("\x1b[?25l");
	}
	showCursor(): void {
		process.stdout.write("\x1b[?25h");
	}
	clearLine(): void {
		process.stdout.write("\x1b[K");
	}
	clearFromCursor(): void {
		process.stdout.write("\x1b[J");
	}
	clearScreen(): void {
		process.stdout.write("\x1b[2J\x1b[H");
	}
	setTitle(title: string): void {
		process.stdout.write(`\x1b]0;${title}\x07`);
	}
	setProgramStatus(status: ProgramStatus): void {
		this.#status = status.state === "clear" ? undefined : status;
		if (this.#statusSupported) process.stdout.write(formatProgramStatus(status));
	}
	setProgress(active: boolean): void {
		process.stdout.write(active ? "\x1b]9;4;3\x07" : "\x1b]9;4;0\x07");
		if (active && !this.#progress) this.#progress = setInterval(() => process.stdout.write("\x1b]9;4;3\x07"), 1000);
		if (!active) {
			clearInterval(this.#progress);
			this.#progress = undefined;
		}
	}
}
