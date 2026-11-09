import { expect, test } from "vitest";
import {
	extractSegments,
	getActiveBackgroundAnsi,
	getOsc8LinkAtColumn,
	normalizeTerminalOutput,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "../src/utils.ts";
import { TestTerminal } from "./support/terminal.ts";

test.each([
	["1;2;3;4;5;7;8;9", "23;24;25;27;28;29"],
	["1;2", "22"],
	["31;44", "39;49"],
	["97;107", "38;2;11;22;33;48;5;201"],
	["38;5;23;48;2;12;34;56", "48;2;90;80;70"],
	["4;9", "0"],
	["31", ""],
	["4", "3"],
])("slicing carries the terminal state after SGR %s then %s", async (initial, change) => {
	const terminal = new TestTerminal(12, 2);
	const text = `\x1b[${initial}mabcd\x1b[${change}mefgh\x1b[0m`;
	const after = extractSegments(text, 1, 6, 1, true).after;
	const read = (row: number, column: number) => {
		const cell = terminal.emulator.buffer.active.getLine(row)?.getCell(column);
		if (!cell) throw new Error("Missing terminal cell");
		return {
			text: cell.getChars(),
			fg: cell.getFgColor(),
			fgMode: cell.getFgColorMode(),
			bg: cell.getBgColor(),
			bgMode: cell.getBgColorMode(),
			bold: Boolean(cell.isBold()),
			dim: Boolean(cell.isDim()),
			italic: Boolean(cell.isItalic()),
			underline: Boolean(cell.isUnderline()),
			inverse: Boolean(cell.isInverse()),
			invisible: Boolean(cell.isInvisible()),
			strike: Boolean(cell.isStrikethrough()),
		};
	};
	try {
		terminal.write(text + "\x1b[0m\x1b[2;1H" + after);
		await terminal.screen();
		expect(stripTerminalSequences(after)).toBe("g");
		expect(read(1, 0)).toEqual(read(0, 6));
	} finally {
		terminal.dispose();
	}
});

test("the legacy bold-off code clears bold while retaining dim when a slice resumes styling", () => {
	expect(extractSegments("\x1b[1;2mabc\x1b[21mdef", 0, 4, 1).after).toBe("\x1b[2me");
});

test("background tracking follows indexed, truecolor, bright and reset sequences", () => {
	for (const [text, expected] of [
		["plain", ""],
		["\x1b[42mtext", "\x1b[42m"],
		["\x1b[104mtext", "\x1b[104m"],
		["\x1b[48;5;200mtext", "\x1b[48;5;200m"],
		["\x1b[48;2;1;2;3mtext", "\x1b[48;2;1;2;3m"],
		["\x1b[42mtext\x1b[49m", ""],
		["\x1b[42mtext\x1b[m", ""],
		["\x1b[42mtext\x1b[48;2m", "\x1b[42m"],
		["\x1b[42mtext\x1b[48;9m", "\x1b[42m"],
	])
		expect(getActiveBackgroundAnsi(text), text).toBe(expected);
});

test.each(["\x07", "\x1b\\"])("wrapped links close and reopen at each row using terminator %j", (terminator) => {
	const open = `\x1b]8;;https://example.test/path${terminator}`,
		close = `\x1b]8;;${terminator}`;
	const rows = wrapTextWithAnsi(open + "abcd efgh" + close, 4);
	expect(rows.map(stripTerminalSequences)).toEqual(["abcd", "efgh"]);
	for (const row of rows) {
		expect(row).toContain(open);
		expect(row.endsWith(close)).toBe(true);
		for (let column = 0; column < 4; column++)
			expect(getOsc8LinkAtColumn(row, column)).toBe("https://example.test/path");
	}
	const shortened = truncateToWidth(open + "abcdefgh" + close, 5, "...");
	expect(stripTerminalSequences(shortened)).toBe("ab...");
	expect(getOsc8LinkAtColumn(shortened, 1)).toBe("https://example.test/path");
	expect(getOsc8LinkAtColumn(shortened, 2)).toBeUndefined();
});

test("normalization decomposes Thai and Lao vowels and expands text tabs without changing control payloads", () => {
	expect(normalizeTerminalOutput("ก\u0e33 ກ\u0eb3")).toBe("ก\u0e4d\u0e32 ກ\u0ecd\u0eb2");
	expect(normalizeTerminalOutput("a\tb")).toBe("a   b");
	const control = "\x1b]0;title\tvalue\x07";
	expect(normalizeTerminalOutput(control + "a\tb")).toBe(control + "a   b");
});

test("width-cache eviction does not change measurements for Unicode or styled text", () => {
	const original = "界🙂";
	expect(visibleWidth(original)).toBe(4);
	for (let index = 0; index < 700; index++) expect(visibleWidth(String.fromCodePoint(0x4e00 + index))).toBe(2);
	expect(visibleWidth(original)).toBe(4);
	expect(visibleWidth("\x1b[31m" + original + "\x1b[0m\t")).toBe(7);
});
