export type OutputLimits = { readonly maxBytes: number; readonly maxLines: number; readonly retain: "head" | "tail" };
export type BoundedOutput = { readonly text: string; readonly droppedBytes: number; readonly droppedLines: number };
export type OutputSlice = BoundedOutput & { readonly bytes: number };
export interface OutputSkip {
	readonly bytes: number;
	readonly newlines: number;
	readonly endsWithNewline: boolean;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
const nativeBuffer = typeof Buffer === "undefined" ? undefined : Buffer;
const nonAscii = /[^\x00-\x7f]/;
const invalidOutput = /[\x00-\x08\x0b-\x1f\ufff9-\ufffb]/g;

export function utf8ByteLength(text: string): number {
	if (nativeBuffer) return nativeBuffer.byteLength(text, "utf8");
	const first = text.search(nonAscii);
	if (first === -1) return text.length;
	let size = first;
	for (let i = first; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code <= 127) size++;
		else if (code <= 2047) size += 2;
		else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
			const next = text.charCodeAt(i + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				size += 4;
				i++;
			} else size += 3;
		} else size += 3;
	}
	return size;
}

export function sanitizeOutput(text: string): string {
	return text.replace(invalidOutput, "");
}

function newlines(text: string): number {
	let count = 0;
	for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1)) count++;
	return count;
}

function lineCount(bytes: Uint8Array): number {
	if (!bytes.length) return 0;
	let count = 0;
	for (let at = bytes.indexOf(10); at !== -1; at = bytes.indexOf(10, at + 1)) count++;
	return count + (bytes[bytes.length - 1] === 10 ? 0 : 1);
}

export function characterEnd(bytes: Uint8Array, offset: number): number {
	while (offset > 0 && ((bytes[offset] ?? 0) & 192) === 128) offset--;
	return offset;
}

function characterStart(bytes: Uint8Array, offset: number): number {
	while (offset < bytes.length && ((bytes[offset] ?? 0) & 192) === 128) offset++;
	return offset;
}

function headRange(bytes: Uint8Array, limits: OutputLimits): [number, number] {
	if (limits.maxLines === 0 || limits.maxBytes === 0) return [0, 0];
	let end = bytes.length;
	let count = 0;
	for (let at = bytes.indexOf(10); at !== -1; at = bytes.indexOf(10, at + 1)) {
		if (++count === limits.maxLines) {
			end = at + 1;
			break;
		}
	}
	if (end > limits.maxBytes) {
		const lastBreak = bytes.lastIndexOf(10, limits.maxBytes - 1);
		end = lastBreak < 0 ? characterEnd(bytes, limits.maxBytes) : lastBreak + 1;
	}
	return [0, end];
}

function tailRange(bytes: Uint8Array, limits: OutputLimits): [number, number] {
	if (limits.maxLines === 0 || limits.maxBytes === 0) return [bytes.length, bytes.length];
	const last = bytes[bytes.length - 1] === 10 ? bytes.length - 2 : bytes.length - 1;
	let start = 0,
		count = 1;
	for (let at = last < 0 ? -1 : bytes.lastIndexOf(10, last); at !== -1; ) {
		if (count === limits.maxLines) {
			start = at + 1;
			break;
		}
		count++;
		at = at === 0 ? -1 : bytes.lastIndexOf(10, at - 1);
	}
	if (bytes.length - start > limits.maxBytes) {
		const from = bytes.length - limits.maxBytes;
		const firstBreak = bytes.indexOf(10, from - 1);
		start = firstBreak >= 0 && firstBreak + 1 < bytes.length ? firstBreak + 1 : characterStart(bytes, from);
	}
	return [start, bytes.length];
}

export function boundOutput(text: string, limits: OutputLimits): OutputSlice {
	const bytes = encoder.encode(text);
	const [start, end] = limits.retain === "head" ? headRange(bytes, limits) : tailRange(bytes, limits);
	const retained = bytes.subarray(start, end);
	const size = retained.length;
	const kept = size === bytes.length ? text : decoder.decode(retained);
	return {
		text: kept,
		bytes: size,
		droppedBytes: bytes.length - size,
		droppedLines: lineCount(bytes) - lineCount(retained),
	};
}

type Chunk = { text: string; bytes: number; newlines: number };

function margin(text: string, limits: OutputLimits): string {
	const bytes = encoder.encode(text);
	const byteEdge = bytes.length > limits.maxBytes ? characterEnd(bytes, bytes.length - limits.maxBytes - 1) : 0;
	let lineEdge = 0;
	let count = 0;
	for (let i = bytes.lastIndexOf(10); i !== -1; i = bytes.lastIndexOf(10, i - 1)) {
		if (++count > limits.maxLines) {
			lineEdge = i;
			break;
		}
		if (i === 0) break;
	}
	const cut = Math.max(byteEdge, lineEdge);
	return cut === 0 ? text : decoder.decode(bytes.subarray(cut));
}

export class OutputBuffer {
	readonly #limits: OutputLimits;
	readonly #decoder = new TextDecoder("utf-8", { ignoreBOM: true });
	#started = false;
	#chunks: Chunk[] = [];
	#bytes = 0;
	#newlines = 0;
	#totalBytes = 0;
	#totalNewlines = 0;
	#terminated = true;
	#headComplete = false;

	constructor(limits: OutputLimits) {
		this.#limits = limits;
	}

	get storedBytes(): number {
		return this.#bytes;
	}

	push(chunk: string | Uint8Array, skipped?: OutputSkip): boolean {
		const pending = typeof chunk === "string" || skipped !== undefined ? this.#decoder.decode() : "";
		let text = typeof chunk === "string" ? chunk : this.#decoder.decode(chunk, { stream: true });
		const atStart = !this.#started && pending === "" && skipped === undefined;
		if (pending !== "" || text !== "" || skipped !== undefined) this.#started = true;
		if (atStart && typeof chunk !== "string" && text.startsWith("\ufeff")) text = text.slice(1);
		if (skipped === undefined) return this.#append(pending + text);
		if (this.#limits.retain !== "tail") throw new Error("Skipped output requires tail retention");
		this.#append(pending);
		if (skipped.bytes !== 0) {
			this.#totalBytes += skipped.bytes;
			this.#totalNewlines += skipped.newlines;
			this.#terminated = skipped.endsWithNewline;
			this.#chunks = [];
			this.#bytes = 0;
			this.#newlines = 0;
		}
		this.#append(text);
		return true;
	}

	end(): void {
		this.#append(this.#decoder.decode());
	}

	#append(text: string): boolean {
		if (text === "") return false;
		const chunk = { text, bytes: utf8ByteLength(text), newlines: newlines(text) };
		this.#totalBytes += chunk.bytes;
		this.#totalNewlines += chunk.newlines;
		this.#terminated = text.endsWith("\n");
		if (this.#headComplete) return true;
		this.#chunks.push(chunk);
		this.#bytes += chunk.bytes;
		this.#newlines += chunk.newlines;
		if (this.#limits.retain === "head") {
			this.#headComplete = this.#bytes > this.#limits.maxBytes || this.#newlines >= this.#limits.maxLines;
		} else {
			while (this.#chunks.length > 1) {
				const first = this.#chunks[0];
				if (
					this.#bytes - first.bytes <= this.#limits.maxBytes + 1 &&
					this.#newlines - first.newlines <= this.#limits.maxLines + 1
				)
					break;
				this.#chunks.shift();
				this.#bytes -= first.bytes;
				this.#newlines -= first.newlines;
			}
		}
		return true;
	}

	snapshot(): BoundedOutput {
		const text = this.#chunks.length === 1 ? this.#chunks[0].text : this.#chunks.map((chunk) => chunk.text).join("");
		const kept = boundOutput(text, this.#limits);
		const keptLines = this.#newlines + (text === "" || text.endsWith("\n") ? 0 : 1) - kept.droppedLines;
		if (this.#limits.retain === "tail" || this.#chunks.length > 1) {
			const retained = this.#limits.retain === "tail" ? margin(text, this.#limits) : text;
			const chunk = {
				text: retained,
				bytes: this.#limits.retain === "tail" ? utf8ByteLength(retained) : this.#bytes,
				newlines: newlines(retained),
			};
			this.#chunks = retained === "" ? [] : [chunk];
			this.#bytes = chunk.bytes;
			this.#newlines = chunk.newlines;
		}
		return {
			text: sanitizeOutput(kept.text),
			droppedBytes: this.#totalBytes - kept.bytes,
			droppedLines: this.#totalNewlines + (this.#terminated ? 0 : 1) - keptLines,
		};
	}
}

export const PROGRESS_BYTES_PER_SECOND = 100 * 1024;

export type ProgressClock = {
	readonly now: () => number;
	readonly setTimer: (callback: () => void, delayMs: number) => () => void;
};
const wallClock: ProgressClock = {
	now: () => Date.now(),
	setTimer: (callback, delayMs) => {
		const handle = setTimeout(callback, delayMs);
		return () => clearTimeout(handle);
	},
};

export class Progress {
	readonly #write: () => Promise<number>;
	readonly #report: (error: unknown) => void;
	readonly #interval: number;
	readonly #clock: ProgressClock;
	#timer: (() => void) | undefined;
	#writing: Promise<void> | undefined;
	#waiters: PromiseWithResolvers<void>[] = [];
	#changed = false;
	#closed = false;
	#readyAt = 0;

	constructor(
		write: () => Promise<number>,
		onError: (error: unknown) => void,
		minIntervalMs: number,
		clock: ProgressClock = wallClock,
	) {
		this.#write = write;
		this.#report = onError;
		this.#interval = minIntervalMs;
		this.#clock = clock;
	}

	mark(): void {
		this.#changed = true;
		this.#schedule();
	}

	markAndWait(): Promise<void> {
		const waiter = Promise.withResolvers<void>();
		this.#waiters.push(waiter);
		this.mark();
		return waiter.promise;
	}

	async stop(): Promise<PromiseWithResolvers<void>[]> {
		this.#closed = true;
		this.#timer?.();
		this.#timer = undefined;
		await this.#writing;
		return this.#waiters.splice(0);
	}

	#schedule(): void {
		if (this.#closed || this.#timer !== undefined || this.#writing !== undefined) return;
		const delay = this.#readyAt - this.#clock.now();
		if (delay <= 0) this.#flush();
		else
			this.#timer = this.#clock.setTimer(() => {
				this.#timer = undefined;
				this.#schedule();
			}, delay);
	}

	#flush(): void {
		if (this.#closed || !this.#changed) return;
		this.#changed = false;
		const batch = this.#waiters.splice(0);
		const started = this.#clock.now();
		this.#writing = this.#write()
			.then(
				(bytes) => {
					this.#readyAt = started + Math.max(this.#interval, (bytes * 1000) / PROGRESS_BYTES_PER_SECOND);
					for (const waiter of batch) waiter.resolve();
				},
				(error: unknown) => {
					this.#readyAt = started + this.#interval;
					for (const waiter of batch) waiter.reject(error);
					this.#report(error);
				},
			)
			.finally(() => {
				this.#writing = undefined;
				if (this.#changed) this.#schedule();
			});
	}
}
