import { afterEach, expect, test, vi } from "vitest";
import { CombinedAutocompleteProvider, type AutocompleteProvider } from "../src/autocomplete.ts";
import type { TuiMouseEvent } from "../src/tui.ts";
import { Editor, wordWrapLine } from "../src/components/editor.ts";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "../src/keybindings.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { visibleWidth } from "../src/utils.ts";
import { TestTerminal } from "./support/terminal.ts";

const plain = (text: string) => text;
const theme = {
	borderColor: plain,
	selectList: { selectedPrefix: plain, selectedText: plain, description: plain, scrollInfo: plain, noMatch: plain },
};
const terminals: TestTerminal[] = [];
afterEach(() => {
	for (const terminal of terminals.splice(0)) terminal.dispose();
	setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
});
function editor() {
	const terminal = new TestTerminal();
	terminals.push(terminal);
	return new Editor(new TuiMainScreen(terminal), theme);
}
function paste(input: Editor, text: string) {
	input.handleInput(`\x1b[200~${text}\x1b[201~`);
}

test("command completion pages through the menu and Enter submits the selected command", async () => {
	const input = editor(),
		sent: string[] = [];
	input.setAutocompleteMaxVisible(3);
	input.setAutocompleteProvider(
		new CombinedAutocompleteProvider(
			["clear", "close", "compact", "continue", "copy", "cost"].map((name) => ({ name })),
			process.cwd(),
		),
	);
	input.onSubmit = (text) => sent.push(text);
	input.setText("/c");
	input.handleInput("\t");
	await vi.waitFor(() => expect(input.isShowingAutocomplete()).toBe(true));
	input.handleInput("\x1b[6~");
	input.handleInput("\x1b[B");
	input.handleInput("\x1b[A");
	expect(input.render(30).join("\n")).toContain("→ continue");
	input.handleInput("\x1b[5~");
	expect(input.render(30).join("\n")).toContain("→ clear");
	input.handleInput("\x1b[B");
	input.handleInput("\r");
	expect(sent).toEqual(["/close"]);
	expect(input.getText()).toBe("");
	expect(input.isShowingAutocomplete()).toBe(false);
});

test("resource completion inserts on Enter without submitting and mouse selection uses menu coordinates", async () => {
	const input = editor(),
		sent: string[] = [];
	const provider: AutocompleteProvider = {
		triggerCharacters: ["#"],
		async getSuggestions() {
			return {
				prefix: "#",
				items: [
					{ value: "#one", label: "One" },
					{ value: "#two", label: "Two" },
				],
			};
		},
		applyCompletion: (_lines, _line, _col, item) => ({
			lines: [item.value + " "],
			cursorLine: 0,
			cursorCol: item.value.length + 1,
		}),
	};
	input.setAutocompleteProvider(provider);
	input.onSubmit = (text) => sent.push(text);
	input.handleInput("#");
	await vi.waitFor(() => expect(input.isShowingAutocomplete()).toBe(true));
	input.render(30);
	const event: TuiMouseEvent = {
		type: "wheel",
		button: "none",
		wheelDelta: 1,
		x: 1,
		y: 3,
		screenX: 1,
		screenY: 3,
		width: 30,
		height: 6,
		shift: false,
		alt: false,
		ctrl: false,
	};
	expect(input.handleMouse(event)).toMatchObject({ handled: true, focus: true });
	input.handleInput("\r");
	expect(input.getText()).toBe("#two ");
	expect(sent).toEqual([]);
	input.setText("#");
	input.handleInput("\t");
	await vi.waitFor(() => expect(input.isShowingAutocomplete()).toBe(true));
	input.render(30);
	expect(input.handleMouse({ ...event, type: "press", button: "left", y: 3 })).toMatchObject({
		handled: true,
		focus: true,
	});
	input.handleMouse({ ...event, type: "click", button: "left", y: 3 });
	expect(input.getText()).toBe("#one ");
	expect(sent).toEqual([]);
});

test("cancelling completion preserves the draft and an empty response closes the menu", async () => {
	const input = editor();
	const provider = new CombinedAutocompleteProvider([{ name: "check" }], process.cwd());
	input.setAutocompleteProvider(provider);
	input.setText("/ch");
	input.handleInput("\t");
	await vi.waitFor(() => expect(input.isShowingAutocomplete()).toBe(true));
	input.handleInput("\x1b");
	expect(input.getText()).toBe("/ch");
	expect(input.isShowingAutocomplete()).toBe(false);
	input.setText("/absent");
	input.handleInput("\t");
	await new Promise((resolve) => setTimeout(resolve, 25));
	expect(input.getText()).toBe("/absent");
	expect(input.isShowingAutocomplete()).toBe(false);
	const plain = editor();
	plain.setText("plain draft");
	plain.handleInput("\t");
	expect(plain.getText()).toBe("plain draft");
});

test("removing an earlier paste renumbers later markers and undo restores their full contents", () => {
	const input = editor();
	const first = Array.from({ length: 12 }, (_, index) => `first ${index}`).join("\n"),
		second = "s".repeat(1100),
		third = Array.from({ length: 12 }, (_, index) => `third ${index}`).join("\n");
	for (const text of [first, second, third]) paste(input, text);
	expect(input.getExpandedText()).toBe(first + second + third);
	input.handleInput("\x01");
	input.handleInput("\x1b[C");
	input.handleInput("\x7f");
	expect(input.getText()).not.toContain("paste #3");
	expect(input.getText()).toContain("paste #1");
	expect(input.getText()).toContain("paste #2");
	expect(input.getExpandedText()).toBe(second + third);
	input.handleInput("\x1f");
	expect(input.getExpandedText()).toBe(first + second + third);
	input.handleInput("\x05");
	paste(input, "fourth");
	const sent: string[] = [];
	input.onSubmit = (text) => sent.push(text);
	input.handleInput("\r");
	expect(sent).toEqual([first + second + third + "fourth"]);
	expect(input.getExpandedText()).toBe("");
});

test("paste strips terminal control bytes, normalizes line endings and separates a path from the preceding word", () => {
	const input = editor();
	input.setText("open");
	paste(input, "/tmp/item\r\nline\tvalue\x00\x03\x1b[97;5u");
	expect(input.getExpandedText()).toBe("open /tmp/item\nline    value");
	input.handleInput("\x1f");
	expect(input.getExpandedText()).toBe("open");
	input.insertTextAtCursor("");
	expect(input.getText()).toBe("open");
});

test("history keeps its newest 100 entries and restores a multiline draft and cursor exactly", () => {
	setKeybindings(
		new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.editor.historyPrevious": "ctrl+p",
			"tui.editor.historyNext": "ctrl+n",
		}),
	);
	const input = editor();
	input.handleInput("\x10");
	for (let index = 0; index < 101; index++) input.addToHistory(` entry ${index} `);
	input.addToHistory("entry 100");
	input.addToHistory(" ");
	input.setText("draft\nline");
	input.handleInput("\x1b[D");
	const cursor = input.getCursor();
	for (let index = 0; index < 110; index++) input.handleInput("\x10");
	expect(input.getText()).toBe("entry 1");
	for (let index = 0; index < 100; index++) input.handleInput("\x0e");
	expect(input.getText()).toBe("draft\nline");
	expect(input.getCursor()).toEqual(cursor);
	input.handleInput("\x0e");
	expect(input.getText()).toBe("draft\nline");
});

test("line and word deletion cross logical boundaries and undo restores the preceding draft", () => {
	for (const [text, keys, expected] of [
		["a\nb", ["\x01", "\x7f"], "ab"],
		["a\nb", ["\x01", "\x1b[A", "\x05", "\x04"], "ab"],
		["abc def", ["\x01", "\x1bd"], " def"],
		["abc def", ["\x17"], "abc "],
		["abc def", ["\x01", "\x1bf", "\x15"], " def"],
		["abc def", ["\x01", "\x0b"], ""],
	] satisfies [string, string[], string][]) {
		const input = editor();
		input.setText(text);
		input.render(20);
		for (const key of keys) input.handleInput(key);
		expect(input.getText()).toBe(expected);
		input.handleInput("\x1f");
		expect(input.getText()).toBe(text);
	}
});

test("wrapping exposes contiguous source offsets and preserves every grapheme and space", () => {
	for (const text of ["one  two   three", "界🙂alpha 日本語 done", "é café 👩‍💻", "before [paste #1 +12 lines] after"])
		for (let width = 2; width <= 30; width++) {
			const chunks = wordWrapLine(text, width);
			expect(chunks.map(({ text }) => text).join("")).toBe(text);
			let end = 0;
			for (const chunk of chunks) {
				expect(chunk.startIndex).toBe(end);
				expect(chunk.text).toBe(text.slice(chunk.startIndex, chunk.endIndex));
				expect(visibleWidth(chunk.text)).toBeLessThanOrEqual(width);
				end = chunk.endIndex;
			}
			expect(end).toBe(text.length);
		}
});
