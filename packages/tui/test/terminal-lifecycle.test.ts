import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { closeSync, openSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
	ProcessTerminal,
	normalizeAppleTerminalInput,
	normalizeNativeShiftEnterInput,
	resolveEscapeTimeoutMs,
} from "../src/terminal.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.useRealTimers();
});
function isolateTerminal() {
	vi.useFakeTimers();
	const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
	vi.spyOn(process, "kill").mockReturnValue(true);
	vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
	vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
	vi.spyOn(process.stdin, "setEncoding").mockReturnValue(process.stdin);
	return { terminal: new ProcessTerminal(), write };
}

test("terminal negotiation replaces fallback keyboard mode with Kitty and preserves bracketed paste", async () => {
	vi.stubEnv("AXI_PROGRAM_STATUS", "0");
	const { terminal, write } = isolateTerminal(),
		input = vi.fn(),
		resize = vi.fn();
	const before = [process.stdin.listenerCount("data"), process.stdout.listenerCount("resize")];
	try {
		terminal.start(input, resize);
		process.stdin.emit("data", "\x1b[?0u");
		expect(terminal.modifyOtherKeysActive).toBe(true);
		process.stdin.emit("data", "\x1b[?7u");
		expect(terminal.kittyProtocolActive).toBe(true);
		expect(terminal.modifyOtherKeysActive).toBe(false);
		expect(write).toHaveBeenCalledWith("\x1b[>4;0m");
		process.stdin.emit("data", "\x1b[200~pasted\ntext\x1b[201~");
		expect(input).toHaveBeenCalledWith("\x1b[200~pasted\ntext\x1b[201~");
		process.stdin.emit("data", "\x1b[?");
		await vi.advanceTimersByTimeAsync(200);
		expect(input).toHaveBeenCalledWith("\x1b[?");
		process.stdout.emit("resize");
		expect(resize).toHaveBeenCalledOnce();
		terminal.stop();
		expect([process.stdin.listenerCount("data"), process.stdout.listenerCount("resize")]).toEqual(before);
		expect(vi.getTimerCount()).toBe(0);
	} finally {
		terminal.stop();
	}
});

test("terminal status negotiation, progress refresh and input draining release all timers", async () => {
	vi.stubEnv("AXI_PROGRAM_STATUS", "");
	const { terminal, write } = isolateTerminal(),
		input = vi.fn();
	try {
		terminal.setProgramStatus({ state: "working" });
		terminal.start(input, () => {});
		process.stdin.emit("data", "\x1b]7501;?supported\x1b\\");
		expect(write).toHaveBeenCalledWith("\x1b]7501;state=working\x1b\\");
		terminal.setProgramStatus({ state: "clear" });
		expect(write).toHaveBeenCalledWith("\x1b]7501;state=clear\x1b\\");
		terminal.setProgress(true);
		terminal.setProgress(true);
		await vi.advanceTimersByTimeAsync(3000);
		expect(write.mock.calls.filter(([value]) => value === "\x1b]9;4;3\x07")).toHaveLength(5);
		terminal.setProgress(false);
		const drain = terminal.drainInput(100, 20);
		process.stdin.emit("data", "ignored during drain");
		await Promise.all([drain, vi.advanceTimersByTimeAsync(100)]);
		expect(input).not.toHaveBeenCalled();
		process.stdin.emit("data", "after drain");
		expect(input.mock.calls.map(([data]) => data).join("")).toBe("after drain");
		terminal.stop();
		expect(vi.getTimerCount()).toBe(0);
	} finally {
		terminal.stop();
	}
});

test("terminal diagnostics write to a file or directory and do not interrupt output when logging fails", async () => {
	const directory = await mkdtemp(join(tmpdir(), "axi-terminal-log-"));
	const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
	try {
		for (const path of [directory, join(directory, "explicit.log")]) {
			vi.stubEnv("AXI_TUI_WRITE_LOG", path);
			new ProcessTerminal().write("output\n");
		}
		const files = await readdir(directory);
		expect(files).toHaveLength(2);
		for (const file of files) expect(await readFile(join(directory, file), "utf8")).toBe("output\n");
		vi.stubEnv("AXI_TUI_WRITE_LOG", join(directory, "missing", "log"));
		expect(() => new ProcessTerminal().write("unlogged")).not.toThrow();
		expect(write).toHaveBeenLastCalledWith("unlogged");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("escape deadlines and native return normalization use explicit connection and modifier information", () => {
	for (const value of ["0", "-1", "invalid", "Infinity", ""])
		expect(resolveEscapeTimeoutMs({ AXI_TUI_ESC_TIMEOUT: value })).toBe(10);
	expect(resolveEscapeTimeoutMs({ SSH_CONNECTION: "remote" })).toBe(100);
	expect(resolveEscapeTimeoutMs({ SSH_TTY: "tty" })).toBe(100);
	expect(resolveEscapeTimeoutMs({ AXI_TUI_ESC_TIMEOUT: "25", SSH_TTY: "tty" })).toBe(25);
	for (const text of ["\r", "\x1b\r"]) {
		expect(normalizeNativeShiftEnterInput(text, true, true)).toBe("\x1b[13;2u");
		expect(normalizeAppleTerminalInput(text, true, true)).toBe("\x1b[13;2u");
		expect(normalizeNativeShiftEnterInput(text, false, true)).toBe(text);
		expect(normalizeNativeShiftEnterInput(text, true, false)).toBe(text);
	}
	expect(normalizeNativeShiftEnterInput("a", true, true)).toBe("a");
});

test("terminal cursor and clearing helpers write only their requested control sequences", () => {
	const write = vi.spyOn(process.stdout, "write").mockReturnValue(true),
		terminal = new ProcessTerminal();
	terminal.moveBy(0);
	terminal.moveBy(-3);
	terminal.moveBy(2);
	terminal.hideCursor();
	terminal.showCursor();
	terminal.clearLine();
	terminal.clearFromCursor();
	terminal.clearScreen();
	expect(write.mock.calls.map(([data]) => data)).toEqual([
		"\x1b[3A",
		"\x1b[2B",
		"\x1b[?25l",
		"\x1b[?25h",
		"\x1b[K",
		"\x1b[J",
		"\x1b[2J\x1b[H",
	]);
});

test("terminal dimensions prefer stdout, then environment values, then defaults", () => {
	const columns = Object.getOwnPropertyDescriptor(process.stdout, "columns"),
		rows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
	try {
		Object.defineProperty(process.stdout, "columns", { value: 0, configurable: true });
		Object.defineProperty(process.stdout, "rows", { value: 0, configurable: true });
		vi.stubEnv("COLUMNS", "96");
		vi.stubEnv("LINES", "48");
		const terminal = new ProcessTerminal();
		expect([terminal.columns, terminal.rows]).toEqual([96, 48]);
		Object.defineProperty(process.stdout, "columns", { value: 72, configurable: true });
		Object.defineProperty(process.stdout, "rows", { value: 20, configurable: true });
		expect([terminal.columns, terminal.rows]).toEqual([72, 20]);
		Object.defineProperty(process.stdout, "columns", { value: 0, configurable: true });
		Object.defineProperty(process.stdout, "rows", { value: 0, configurable: true });
		vi.stubEnv("COLUMNS", "invalid");
		vi.stubEnv("LINES", "");
		expect([terminal.columns, terminal.rows]).toEqual([80, 24]);
	} finally {
		if (columns) Object.defineProperty(process.stdout, "columns", columns);
		else Reflect.deleteProperty(process.stdout, "columns");
		if (rows) Object.defineProperty(process.stdout, "rows", rows);
		else Reflect.deleteProperty(process.stdout, "rows");
	}
});

test.each(["fresh", "fallback", "kitty"] as const)(
	"synchronous exit restoration writes %s modes to the real output descriptor",
	async (mode) => {
		const directory = await mkdtemp(join(tmpdir(), "axi-terminal-exit-")),
			path = join(directory, "exit.txt");
		const { terminal } = isolateTerminal();
		vi.stubEnv("AXI_PROGRAM_STATUS", "0");
		const original = Object.getOwnPropertyDescriptor(process.stdout, "fd");
		if (!original) throw new Error("Missing stdout descriptor");
		const descriptor = openSync(path, "w+");
		try {
			if (mode !== "fresh") {
				terminal.start(
					() => {},
					() => {},
				);
				process.stdin.emit("data", mode === "kitty" ? "\x1b[?7u" : "\x1b[?0u");
				terminal.setProgress(true);
			}
			try {
				Object.defineProperty(process.stdout, "fd", { ...original, value: descriptor });
				terminal.restoreOnExit("before", "after");
			} finally {
				Object.defineProperty(process.stdout, "fd", original);
			}
			expect(readFileSync(path, "utf8")).toBe(
				"before" +
					(mode === "fresh" ? "" : "\x1b]9;4;0\x07") +
					"\x1b[?2004l" +
					(mode === "fresh" ? "" : "\x1b[<u") +
					(mode === "fallback" ? "\x1b[>4;0m" : "") +
					"after",
			);
		} finally {
			terminal.stop();
			closeSync(descriptor);
			await rm(directory, { recursive: true, force: true });
		}
	},
);

test("a preselected program status is advertised immediately when support is configured", () => {
	vi.stubEnv("AXI_PROGRAM_STATUS", "1");
	const { terminal, write } = isolateTerminal();
	try {
		terminal.setProgramStatus({ state: "working" });
		terminal.start(
			() => {},
			() => {},
		);
		expect(write.mock.calls.map(([data]) => data)).toContain("\x1b]7501;state=working\x1b\\");
	} finally {
		terminal.stop();
	}
});

test("device replies end status negotiation and repeated keyboard reports cannot enable modes twice", () => {
	vi.stubEnv("AXI_PROGRAM_STATUS", "");
	const { terminal, write } = isolateTerminal(),
		input = vi.fn();
	try {
		terminal.setProgramStatus({ state: "working" });
		terminal.start(input, () => {});
		process.stdin.emit("data", "\x1b[?1;2c");
		process.stdin.emit("data", "\x1b]7501;?supported\x1b\\");
		process.stdin.emit("data", "\x1b[?0u");
		process.stdin.emit("data", "\x1b[?0u");
		expect(write.mock.calls.filter(([data]) => data === "\x1b[>4;2m")).toHaveLength(1);
		expect(write.mock.calls.map(([data]) => data)).not.toContain("\x1b]7501;state=working\x1b\\");
		process.stdin.emit("data", "\x1b[?1;2c");
		expect(input).toHaveBeenLastCalledWith("\x1b[?1;2c");
		process.stdin.emit("data", "\x1b[?7u");
		process.stdin.emit("data", "\x1b[?0u");
		expect(terminal.kittyProtocolActive).toBe(true);
		expect(terminal.modifyOtherKeysActive).toBe(false);
	} finally {
		terminal.stop();
	}
});
