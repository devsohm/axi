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
