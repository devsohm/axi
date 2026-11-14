import { expect, test, vi } from "vitest";
import { normalizeNativeShiftEnterInput, ProcessTerminal } from "../src/terminal.ts";
import { decodeKittyPrintable, matchesKey, parseKey } from "../src/keys.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { sliceByColumn, wrapTextWithAnsi } from "../src/utils.ts";
import { CURSOR_MARKER } from "../src/tui.ts";
import { detectCapabilities } from "../src/terminal-image.ts";
import { TestTerminal } from "./support/terminal.ts";
import { CancellableLoader } from "../src/components/cancellable-loader.ts";
import { ScrollView } from "../src/components/scroll-view.ts";

test("column slicing carries color but leaves earlier cursor metadata behind", () => {
	expect(sliceByColumn(`\x1b[31mab${CURSOR_MARKER}cdef`, 4, 2, true)).toBe("\x1b[31mef");
	expect(sliceByColumn(`ab${CURSOR_MARKER}cdef`, 2, 2, true)).toBe(`${CURSOR_MARKER}cd`);
});

test("cursor metadata is removed from selected, repeated and offscreen render lines", async () => {
	const terminal = new TestTerminal(20, 2);
	const writes: string[] = [];
	const write = terminal.write.bind(terminal);
	terminal.write = (data) => {
		writes.push(data);
		write(data);
	};
	const ui = new TuiMainScreen(terminal);
	ui.addChild({
		render: () => [`old${CURSOR_MARKER}`, `ab${CURSOR_MARKER}cd${CURSOR_MARKER}`, `end${CURSOR_MARKER}`],
		invalidate() {},
	});
	try {
		ui.start();
		await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("end"));
		expect(writes.join("")).not.toContain(CURSOR_MARKER);
	} finally {
		ui.stop();
		terminal.dispose();
	}
});

test("Alacritty advertises hyperlinks without TERM_PROGRAM", () => {
	const env = process.env;
	try {
		process.env = { TERM: "alacritty" };
		expect(detectCapabilities().hyperlinks).toBe(true);
		process.env = { TERM: "xterm-256color", ALACRITTY_WINDOW_ID: "42" };
		expect(detectCapabilities().hyperlinks).toBe(true);
	} finally {
		process.env = env;
	}
});

test("scrollbar policy overrides determine both content width and visibility", () => {
	class VisibleScroll extends ScrollView {
		override get scrollbar() {
			return "always" as const;
		}
	}
	const view = new VisibleScroll({ render: (width) => [String(width)], invalidate() {} });
	view.updateLayout(10, 3, () => {});
	expect(view.getContentWidth(10)).toBe(9);
	expect(view.isScrollbarVisible).toBe(true);
});

test("loader cancellation state belongs to its own controller", () => {
	class ExternalSignalLoader extends CancellableLoader {
		override get signal() {
			return AbortSignal.abort();
		}
	}
	const loader = new ExternalSignalLoader(
		{ requestRender() {} },
		(text) => text,
		(text) => text,
	);
	try {
		expect(loader.signal.aborted).toBe(true);
		expect(loader.aborted).toBe(false);
		loader.handleInput("x");
		expect(loader.aborted).toBe(false);
		loader.handleInput("\x1b");
		expect(loader.aborted).toBe(true);
	} finally {
		loader.dispose();
	}
});

test("native Shift+Enter accepts plain and escape-prefixed returns without changing Alt+Enter", () => {
	for (const input of ["\r", "\x1b\r"]) {
		expect(normalizeNativeShiftEnterInput(input, true, true)).toBe("\x1b[13;2u");
		expect(normalizeNativeShiftEnterInput(input, true, false)).toBe(input);
		expect(normalizeNativeShiftEnterInput(input, false, true)).toBe(input);
	}
	expect(normalizeNativeShiftEnterInput("x", true, true)).toBe("x");
});

test("function keys preserve their modifiers and unknown functional keys insert no text", () => {
	for (const [sequence, expected] of [
		["\x1b[P", "f1"],
		["\x1b[1;5Q", "ctrl+f2"],
		["\x1b[1;2S", "shift+f4"],
		["\x1b[24;3~", "alt+f12"],
	] as const) {
		expect(parseKey(sequence)).toBe(expected);
		expect(matchesKey(sequence, expected)).toBe(true);
	}
	expect(decodeKittyPrintable("\x1b[57382u")).toBeUndefined();
});

test("terminal titles cannot inject terminal control sequences", () => {
	const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
	try {
		new ProcessTerminal().setTitle("Work\x07\x1b]52;c;YWJj\x07\x9b2J");
		expect(output).toHaveBeenCalledWith("\x1b]0;Work ]52;c;YWJj 2J\x07");
	} finally {
		output.mockRestore();
	}
});

test("wrapping styled words drops the following space and keeps the style reset", () => {
	expect(wrapTextWithAnsi("\x1b[1mone\x1b[22m two", 3)).toEqual(["\x1b[1mone\x1b[22m", "two"]);
	expect(wrapTextWithAnsi("\x1b[9mabc def\x1b[29m", 3)).toEqual(["\x1b[9mabc\x1b[29m", "\x1b[9mdef\x1b[29m"]);
});

test("scrollback output removes shell prompt markers while preserving the rendered content", async () => {
	const terminal = new TestTerminal(20, 4);
	const writes: string[] = [];
	const write = terminal.write.bind(terminal);
	terminal.write = (data) => {
		writes.push(data);
		write(data);
	};
	const ui = new TuiMainScreen(terminal);
	ui.addChild({ render: () => ["\x1b]133;A\x07\x1b]133;B\x1b\\input", "\x1b]133;C\x07output"], invalidate() {} });
	try {
		ui.start();
		await vi.waitFor(async () => expect((await terminal.screen()).slice(0, 2)).toEqual(["input", "output"]));
		expect(writes.join("")).not.toContain("\x1b]133;");
	} finally {
		ui.stop();
		terminal.dispose();
	}
});
