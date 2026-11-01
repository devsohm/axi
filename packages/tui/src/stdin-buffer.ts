import { EventEmitter } from "node:events";

const pasteStart = "\x1b[200~";
const pasteEnd = "\x1b[201~";
const replyHeader = /^\x1b(?:\](?:1[01];|4;\d{1,3};|7501;\?)|P>\||_G(?:[a-z]=\d+,)*[a-z]=\d+;)/;
const isControlString = (text: string): boolean => /^\x1b[\]P_]/.test(text);

export type StdinBufferOptions = { timeout?: number; escapeTimeout?: number };
export type StdinBufferEventMap = { data: [string]; paste: [string] };

function sequenceLength(input: string): number | undefined {
	if (input[0] !== "\x1b") return 1;
	if (input.length === 1) return undefined;
	const kind = input[1];
	if (kind === "[" && input[2] === "M") return input.length >= 6 ? 6 : undefined;
	if (kind === "[") {
		for (let index = 2; index < input.length; index++) {
			const code = input.charCodeAt(index);
			if (code < 0x40 || code > 0x7e) continue;
			if (input[2] === "<" && !/^\x1b\[<\d+;\d+;\d+[Mm]$/.test(input.slice(0, index + 1))) continue;
			return index + 1;
		}
		return undefined;
	}
	if (kind === "]" || kind === "P" || kind === "_") {
		for (let index = 2; index < input.length; index++) {
			if (replyHeader.test(input)) {
				if (input[index] === "\x18" || input[index] === "\x1a") return index + 1;
				if (input[index] === "\x1b" && index + 1 < input.length && input[index + 1] !== "\\") return index;
			}
			if (kind === "]" && input[index] === "\x07") return index + 1;
			if (input[index] === "\x1b" && input[index + 1] === "\\") return index + 2;
		}
		return undefined;
	}
	if (kind === "O") return input.length >= 3 ? 3 : undefined;
	if (kind === "\x1b" && "[]OP_".includes(input[2] ?? "\0")) return 1;
	return 2;
}

function splitSequences(input: string): { sequences: string[]; remainder: string } {
	const sequences: string[] = [];
	let position = 0;
	while (position < input.length) {
		const length = sequenceLength(input.slice(position));
		if (length === undefined) break;
		const sequence = input.slice(position, position + length);
		position += length;
		if (
			!replyHeader.test(sequence) ||
			(sequence[1] === "]" && sequence.endsWith("\x07")) ||
			sequence.endsWith("\x1b\\")
		)
			sequences.push(sequence);
	}
	return { sequences, remainder: input.slice(position) };
}

export class StdinBuffer extends EventEmitter<StdinBufferEventMap> {
	#pending = "";
	#paste: string | undefined;
	#duplicate: number | undefined;
	#timer: ReturnType<typeof setTimeout> | undefined;
	readonly #timeout: number;
	readonly #escapeTimeout: number;

	constructor(options: StdinBufferOptions = {}) {
		super();
		this.#timeout = options.timeout ?? 50;
		this.#escapeTimeout = options.escapeTimeout ?? 10;
	}

	#cancelTimer(): void {
		clearTimeout(this.#timer);
		this.#timer = undefined;
	}

	#deliver(sequence: string): void {
		if (sequence.length === 1 && sequence.codePointAt(0) === this.#duplicate) {
			this.#duplicate = undefined;
			return;
		}
		const printable = /^\x1b\[(\d+)(?::\d*)?(?::\d+)?u$/.exec(sequence);
		const codepoint = printable ? Number(printable[1]) : undefined;
		this.#duplicate = codepoint !== undefined && codepoint >= 32 ? codepoint : undefined;
		this.emit("data", sequence);
	}

	process(data: string | Buffer): void {
		this.#cancelTimer();
		const text =
			typeof data === "string"
				? data
				: data.length === 1 && data[0] > 127
					? `\x1b${String.fromCharCode(data[0] - 128)}`
					: data.toString();
		if (!text && !this.#pending) {
			this.#deliver("");
			return;
		}
		this.#pending += text;
		while (this.#pending.length || this.#paste !== undefined) {
			if (this.#paste !== undefined) {
				this.#paste += this.#pending;
				this.#pending = "";
				const end = this.#paste.indexOf(pasteEnd);
				if (end < 0) return;
				const content = this.#paste.slice(0, end);
				this.#pending = this.#paste.slice(end + pasteEnd.length);
				this.#paste = undefined;
				this.#duplicate = undefined;
				this.emit("paste", content);
				continue;
			}
			const start = this.#pending.indexOf(pasteStart);
			if (start >= 0) {
				for (const sequence of splitSequences(this.#pending.slice(0, start)).sequences) this.#deliver(sequence);
				this.#pending = this.#pending.slice(start + pasteStart.length);
				this.#paste = "";
				this.#duplicate = undefined;
				continue;
			}
			const parsed = splitSequences(this.#pending);
			this.#pending = parsed.remainder;
			for (const sequence of parsed.sequences) this.#deliver(sequence);
			break;
		}
		if (this.#pending.length) {
			if (replyHeader.test(this.#pending)) return;
			const delay = this.#pending === "\x1b" ? this.#escapeTimeout : this.#timeout;
			this.#timer = setTimeout(() => {
				for (const sequence of this.flush()) {
					if (sequence.length > 2 && isControlString(sequence)) {
						this.#deliver(sequence.slice(0, 2));
						this.process(sequence.slice(2));
					} else this.#deliver(sequence);
				}
			}, delay);
		}
	}

	flush(): string[] {
		this.#cancelTimer();
		if (!this.#pending) return [];
		const remaining = this.#pending;
		this.#pending = "";
		this.#duplicate = undefined;
		return [remaining];
	}

	getBuffer(): string {
		return this.#pending;
	}
	clear(): void {
		this.#cancelTimer();
		this.#pending = "";
		this.#paste = undefined;
		this.#duplicate = undefined;
	}
	destroy(): void {
		this.clear();
	}
}
