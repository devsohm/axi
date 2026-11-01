import { describe, expect, it, vi } from "vitest";
import { StdinBuffer } from "../src/stdin-buffer.ts";
import { parseOscColorResponse, parseTerminalColorSchemeReport } from "../src/terminal-colors.ts";

describe("input framing", () => {
	it("reassembles a mouse sequence across every split point", () => {
		const input = "\x1b[<35;20;5m";
		for (let split = 1; split < input.length; split++) {
			const buffer = new StdinBuffer();
			const output: string[] = [];
			buffer.on("data", (sequence) => output.push(sequence));
			buffer.process(input.slice(0, split));
			expect(output).toEqual([]);
			buffer.process(input.slice(split));
			expect(output).toEqual([input]);
			buffer.destroy();
		}
	});

	it("keeps pasted controls out of ordinary input and resumes afterward", () => {
		const buffer = new StdinBuffer();
		const keys: string[] = [];
		const pastes: string[] = [];
		buffer.on("data", (value) => keys.push(value));
		buffer.on("paste", (value) => pastes.push(value));
		buffer.process("a\x1b[200~line\n\x03\x1b[20");
		buffer.process("1~b");
		expect(keys).toEqual(["a", "b"]);
		expect(pastes).toEqual(["line\n\x03"]);
		buffer.destroy();
	});

	it("starts a paste after an unfinished terminal sequence", () => {
		for (const prefix of ["\x1b[", "\x1b[<35", "\x1b]11;rgb:unfinished", "\x1bP>|unfinished"]) {
			const input = `${prefix}\x1b[200~line\n\x03\x1b[201~z`;
			for (const split of [1, prefix.length, input.length - 1]) {
				const buffer = new StdinBuffer();
				const keys: string[] = [];
				const pastes: string[] = [];
				buffer.on("data", (value) => keys.push(value));
				buffer.on("paste", (value) => pastes.push(value));
				try {
					buffer.process(input.slice(0, split));
					buffer.process(input.slice(split));
					expect(keys, JSON.stringify({ prefix, split })).toEqual(["z"]);
					expect(pastes).toEqual(["line\n\x03"]);
					expect(buffer.getBuffer()).toBe("");
				} finally {
					buffer.destroy();
				}
			}
		}
	});

	it("suppresses a raw duplicate after an unmodified printable keyboard report", () => {
		const buffer = new StdinBuffer();
		const output: string[] = [];
		buffer.on("data", (value) => output.push(value));
		buffer.process("\x1b[97uaab");
		expect(output).toEqual(["\x1b[97u", "a", "b"]);
		buffer.destroy();
	});
});

describe("terminal colors", () => {
	it("normalizes variable-width channel replies", () => {
		expect(parseOscColorResponse("\x1b]10;rgb:ffff/8000/0000\x1b\\")).toEqual({
			target: "foreground",
			rgb: { r: 255, g: 128, b: 0 },
		});
		expect(parseOscColorResponse("\x1b]4;15;#123456\x07")).toEqual({
			target: 15,
			rgb: { r: 18, g: 52, b: 86 },
		});
	});

	it("distinguishes an invalid color from an unrelated sequence", () => {
		expect(parseOscColorResponse("\x1b]11;rgb:xx/ff/00\x07")).toEqual({ target: "background", rgb: undefined });
		expect(parseOscColorResponse("text")).toBeUndefined();
		expect(parseTerminalColorSchemeReport("\x1b[?997;1n\x1b[?997;2n")).toBe("light");
		expect(parseTerminalColorSchemeReport("\x1b[?997;3n")).toBeUndefined();
	});
});

it("keeps terminal replies atomic across every split and resumes ordinary keys afterward", () => {
	for (const reply of [
		"\x1b]11;rgb:aa/bb/cc\x07",
		"\x1bP>|terminal\x1b\\",
		"\x1b_Gi=1;OK\x1b\\",
		"\x1b[97;5u",
		"\x1bOP",
	]) {
		for (let split = 1; split < reply.length; split++) {
			const buffer = new StdinBuffer();
			const received: string[] = [];
			buffer.on("data", (value) => received.push(value));
			try {
				buffer.process(reply.slice(0, split));
				expect(received).toEqual([]);
				buffer.process(reply.slice(split) + "z");
				expect(received).toEqual([reply, "z"]);
			} finally {
				buffer.destroy();
			}
		}
	}
});

it("discards interrupted control-string replies containing a bell", () => {
	for (const prefix of ["\x1bP>|", "\x1b_Gi=1;"]) {
		const buffer = new StdinBuffer();
		const keys: string[] = [];
		buffer.on("data", (value) => keys.push(value));
		try {
			buffer.process(`${prefix}\x07\x1b[A`);
			expect(keys).toEqual(["\x1b[A"]);
			expect(buffer.getBuffer()).toBe("");
		} finally {
			buffer.destroy();
		}
	}
});

it("captures input timeouts when the buffer is constructed", () => {
	vi.useFakeTimers();
	const options = { timeout: 40, escapeTimeout: 12 };
	const buffer = new StdinBuffer(options);
	const keys: string[] = [];
	buffer.on("data", (value) => keys.push(value));
	options.timeout = options.escapeTimeout = 1;
	try {
		buffer.process("\x1b");
		vi.advanceTimersByTime(11);
		expect(keys).toEqual([]);
		vi.advanceTimersByTime(1);
		expect(keys).toEqual(["\x1b"]);
		buffer.process("\x1b[");
		vi.advanceTimersByTime(39);
		expect(keys).toEqual(["\x1b"]);
		vi.advanceTimersByTime(1);
		expect(keys).toEqual(["\x1b", "\x1b["]);
	} finally {
		buffer.destroy();
		vi.useRealTimers();
	}
});

it("emits an empty input chunk while preserving an unfinished paste", () => {
	const buffer = new StdinBuffer();
	const keys: string[] = [];
	const pastes: string[] = [];
	buffer.on("data", (value) => keys.push(value));
	buffer.on("paste", (value) => pastes.push(value));
	try {
		buffer.process("\x1b[200~first");
		buffer.process("");
		buffer.process(" second\x1b[201~z");
		expect(keys).toEqual(["", "z"]);
		expect(pastes).toEqual(["first second"]);
	} finally {
		buffer.destroy();
	}
});
