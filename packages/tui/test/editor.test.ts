import { afterEach, expect, test, vi } from "vitest";
import { Editor, wordWrapLine } from "../src/components/editor.ts";
import { CombinedAutocompleteProvider } from "../src/autocomplete.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { KeybindingsManager, TUI_KEYBINDINGS, setKeybindings } from "../src/keybindings.ts";
import { TestTerminal } from "./support/terminal.ts";

const plain = (text: string) => text;
const theme = {
	borderColor: plain,
	selectList: {
		selectedPrefix: plain,
		selectedText: plain,
		description: plain,
		scrollInfo: plain,
		noMatch: plain,
	},
};
const terminals: TestTerminal[] = [];
function editor() {
	const terminal = new TestTerminal();
	terminals.push(terminal);
	return new Editor(new TuiMainScreen(terminal), theme);
}
afterEach(() => {
	for (const terminal of terminals.splice(0)) terminal.dispose();
	setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
});

test("Unicode editing, multiline submission and undo preserve the caller's text", () => {
	const input = editor();
	const submitted: string[] = [];
	input.onSubmit = (text) => submitted.push(text);
	input.handleInput("A");
	input.handleInput("🙂");
	input.handleInput("界");
	input.handleInput("\x1b[D");
	input.handleInput("\x7f");
	expect(input.getText()).toBe("A界");
	input.handleInput("\x1f");
	expect(input.getText()).toBe("A🙂界");
	input.handleInput("\x05");
	input.handleInput("\n");
	input.handleInput("next");
	input.handleInput("\r");
	expect(submitted).toEqual(["A🙂界\nnext"]);
	expect(input.getText()).toBe("");
});

test("paste markers remain atomic while submission expands the full payload", () => {
	const input = editor();
	const payload = Array.from({ length: 14 }, (_, i) => `row ${i}`).join("\n");
	input.handleInput("\x1b[200~" + payload.slice(0, 20));
	input.handleInput(payload.slice(20) + "\x1b[201~");
	expect(input.getExpandedText()).toBe(payload);
	expect(input.getText()).toBe("[paste #1 +14 lines]");
	input.handleInput("\x7f");
	expect(input.getText()).toBe("");
	input.handleInput("\x1f");
	expect(input.getExpandedText()).toBe(payload);
	const submitted: string[] = [];
	input.onSubmit = (text) => submitted.push(text);
	input.handleInput("\r");
	expect(submitted).toEqual([payload]);
});

test("history navigation restores the unfinished draft and respects custom bindings", () => {
	setKeybindings(
		new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.editor.historyPrevious": "ctrl+p",
			"tui.editor.historyNext": "ctrl+n",
		}),
	);
	const input = editor();
	input.addToHistory("first");
	input.addToHistory("second");
	input.setText("draft");
	input.handleInput("\x10");
	expect(input.getText()).toBe("second");
	input.handleInput("\x10");
	expect(input.getText()).toBe("first");
	input.handleInput("\x0e");
	expect(input.getText()).toBe("second");
	input.handleInput("\x0e");
	expect(input.getText()).toBe("draft");
	input.handleInput("\x15");
	expect(input.getText()).toBe("");
	input.handleInput("\x19");
	expect(input.getText()).toBe("draft");
});

test("command completion inserts a single result and stale requests cannot replace later input", async () => {
	const input = editor();
	input.setAutocompleteProvider(
		new CombinedAutocompleteProvider([{ name: "status", description: "Show state" }], process.cwd()),
	);
	input.setText("/sta");
	input.handleInput("\t");
	await vi.waitFor(() => expect(input.isShowingAutocomplete()).toBe(true));
	input.handleInput("\t");
	expect(input.getText()).toBe("/status ");
	let release!: (value: { items: { value: string; label: string }[]; prefix: string }) => void;
	input.setAutocompleteProvider({
		getSuggestions: () =>
			new Promise((resolve) => {
				release = resolve;
			}),
		applyCompletion: () => ({ lines: ["stale"], cursorLine: 0, cursorCol: 5 }),
	});
	input.setText("/old");
	input.handleInput("\t");
	await vi.waitFor(() => expect(typeof release).toBe("function"));
	input.setText("new draft");
	release({ items: [{ value: "old", label: "old" }], prefix: "/old" });
	await new Promise((resolve) => setTimeout(resolve, 30));
	expect(input.getText()).toBe("new draft");
	expect(input.isShowingAutocomplete()).toBe(false);
});

test("word deletion and kill-ring rotation remain reversible across distinct edits", () => {
	const input = editor();
	input.setText("alpha beta gamma");
	input.handleInput("\x17");
	expect(input.getText()).toBe("alpha beta ");
	input.handleInput("\x15");
	expect(input.getText()).toBe("");
	input.handleInput("\x19");
	expect(input.getText()).toBe("alpha beta gamma");
	input.setText("separate");
	input.handleInput("\x15");
	input.handleInput("\x19");
	expect(input.getText()).toBe("separate");
	input.handleInput("\x1by");
	expect(input.getText()).toBe("alpha beta gamma");
	input.handleInput("\x1f");
	expect(input.getText()).toBe("separate");
});

test("programmatic insertion preserves newlines and disabled submission retains the editable draft", () => {
	const input = editor(),
		submitted: string[] = [];
	input.onSubmit = (text) => submitted.push(text);
	input.setText("start");
	input.insertTextAtCursor("\r\nnext");
	expect(input.getText()).toBe("start\nnext");
	input.disableSubmit = true;
	input.handleInput("\r");
	expect(submitted).toEqual([]);
	expect(input.getText()).toBe("start\nnext");
	input.disableSubmit = false;
	input.handleInput("\r");
	expect(submitted).toEqual(["start\nnext"]);
	expect(input.getText()).toBe("");
});

test("a single grapheme wider than its line capacity reports a range error", () => {
	expect(() => wordWrapLine("界", 1)).toThrowError(new RangeError("Maximum call stack size exceeded"));
});

test("forward deletion keeps the preferred column for the next wrapped-line move", () => {
	const input = editor();
	input.setText("xy\nabcd");
	input.render(29);
	input.handleInput("\x1b[A");
	expect(input.getCursor()).toEqual({ line: 0, col: 2 });
	input.handleInput("\x1bd");
	expect(input.getText()).toBe("xyabcd");
	input.render(4);
	input.handleInput("\x1b[B");
	expect(input.getCursor()).toEqual({ line: 0, col: 6 });
});

test("character search can be cancelled and a control key still edits after cancelling search", () => {
	const input = editor();
	input.setText("a界b界c");
	input.handleInput("\x01");
	input.handleInput("\x1d");
	input.handleInput("界");
	expect(input.getCursor()).toEqual({ line: 0, col: 1 });
	input.handleInput("\x1d");
	input.handleInput("\x1d");
	input.handleInput("x");
	expect(input.getText()).toBe("ax界b界c");
	input.handleInput("\x1d");
	input.handleInput("\x05");
	expect(input.getCursor()).toEqual({ line: 0, col: 6 });
});

test("shifted character deletion removes one grapheme and undo restores it", () => {
	const input = editor();
	input.setText("A🙂界B");
	input.handleInput("\x1b[D");
	input.handleInput("\x1b[127;2u");
	expect(input.getText()).toBe("A🙂B");
	input.handleInput("\x1f");
	expect(input.getText()).toBe("A🙂界B");
	input.handleInput("\x01");
	input.handleInput("\x1b[3;2~");
	expect(input.getText()).toBe("🙂界B");
	input.handleInput("\x1f");
	expect(input.getText()).toBe("A🙂界B");
});

test("shifted backspace takes precedence over a forward-delete binding", () => {
	setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, { "tui.editor.deleteCharForward": "shift+backspace" }));
	const input = editor();
	input.setText("abc");
	input.handleInput("\x1b[D");
	input.handleInput("\x1b[127;2u");
	expect(input.getText()).toBe("ac");
	expect(input.getCursor()).toEqual({ line: 0, col: 1 });
});

test("right movement wins when both horizontal actions share a binding", () => {
	setKeybindings(
		new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.editor.cursorLeft": "ctrl+x",
			"tui.editor.cursorRight": "ctrl+x",
		}),
	);
	const input = editor();
	input.setText("abc");
	input.handleInput("\x01");
	input.handleInput("\x18");
	expect(input.getCursor()).toEqual({ line: 0, col: 1 });
});

test.each(["left\tright", "left\rright"])("kill and yank preserve existing input bytes: %j", (text) => {
	const input = editor();
	input.handleInput(text);
	expect(input.getText()).toBe(text);
	input.handleInput("\x15");
	expect(input.getText()).toBe("");
	input.handleInput("\x19");
	expect(input.getText()).toBe(text);
});

test("enter-as-newline bindings allow a trailing backslash to submit without retaining it", () => {
	setKeybindings(
		new KeybindingsManager(TUI_KEYBINDINGS, { "tui.input.newLine": "enter", "tui.input.submit": "shift+enter" }),
	);
	const input = editor(),
		submitted: string[] = [];
	input.onSubmit = (text) => submitted.push(text);
	input.setText("first");
	input.handleInput("\r");
	expect(input.getText()).toBe("first\n");
	input.handleInput("second\\");
	input.handleInput("\r");
	expect(submitted).toEqual(["first\nsecond"]);
	expect(input.getText()).toBe("");
});

test("bracketed paste filters encoded control letters and processes text following its end marker", () => {
	const input = editor();
	input.handleInput("\x1b[200~B\x1b[65;5uC\x1b[97;5uD\x1b[201~tail");
	expect(input.getText()).toBe("BCDtail");
	input.handleInput("\x1b[200~\x1b[201~end");
	expect(input.getText()).toBe("BCDtailend");
	input.handleInput("\x1b[32;2u");
	expect(input.getText()).toBe("BCDtailend ");
});

test("copy and empty kill-ring shortcuts leave the draft unchanged", () => {
	const input = editor();
	input.setText("draft");
	for (const key of ["\x19", "\x1by", "\x03"]) input.handleInput(key);
	expect(input.getText()).toBe("draft");
	expect(input.getCursor()).toEqual({ line: 0, col: 5 });
	input.invalidate();
	expect(input.render(20).join("\n")).toContain("draft");
});

test("page navigation reaches both ends of a multiline draft without changing text", () => {
	const input = editor();
	const text = Array.from({ length: 15 }, (_, i) => `row${i}`).join("\n");
	input.setText(text);
	input.render(25);
	for (let i = 0; i < 20; i++) input.handleInput("\x1b[5~");
	expect(input.getCursor()).toEqual({ line: 0, col: 4 });
	for (let i = 0; i < 20; i++) input.handleInput("\x1b[6~");
	expect(input.getCursor()).toEqual({ line: 14, col: 5 });
	expect(input.getText()).toBe(text);
});
