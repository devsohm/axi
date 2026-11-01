import { expect, test, vi } from "vitest";
import { normalizeNativeShiftEnterInput, ProcessTerminal } from "../src/terminal.ts";
import { decodeKittyPrintable, matchesKey, parseKey } from "../src/keys.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { wrapTextWithAnsi } from "../src/utils.ts";
import { TestTerminal } from "./support/terminal.ts";

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
