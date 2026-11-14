import { afterEach, expect, test, vi } from "vitest";
import { Editor } from "../src/components/editor.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { stripTerminalSequences, visibleWidth } from "../src/utils.ts";
import type { TuiMouseEvent } from "../src/tui.ts";
import { TestTerminal } from "./support/terminal.ts";

const plain = (text: string) => text;
const theme = {
	borderColor: plain,
	selectList: { selectedPrefix: plain, selectedText: plain, description: plain, scrollInfo: plain, noMatch: plain },
};
const resources: { ui: TuiMainScreen | TuiAltScreen; terminal: TestTerminal }[] = [];
afterEach(() => {
	for (const { ui, terminal } of resources.splice(0)) {
		ui.stop();
		terminal.dispose();
	}
});
function setup(mode: "main" | "alternate" = "main") {
	const terminal = new TestTerminal(16, 12),
		ui = mode === "main" ? new TuiMainScreen(terminal) : new TuiAltScreen(terminal);
	resources.push({ ui, terminal });
	const editor = new Editor(ui, theme, { paddingX: 1 });
	ui.addChild(editor);
	ui.setFocus(editor);
	return { ui, terminal, editor };
}

for (const mode of ["main", "alternate"] as const)
	test(`${mode} screen renders the bordered editor, resizes wrapped text and submits the full draft`, async () => {
		const { ui, terminal, editor } = setup(mode),
			submitted: string[] = [];
		editor.onSubmit = (text) => submitted.push(text);
		ui.start();
		terminal.input("hi🙂");
		await vi.waitFor(async () =>
			expect((await terminal.screen()).slice(0, 3)).toEqual(["────────────────", " hi🙂", "────────────────"]),
		);
		editor.setText("abc def ghi");
		ui.requestRender();
		terminal.resize(8, 12);
		await vi.waitFor(async () =>
			expect((await terminal.screen()).slice(0, 5)).toEqual(["────────", " abc", " def", " ghi", "────────"]),
		);
		terminal.input("\r");
		expect(submitted).toEqual(["abc def ghi"]);
		expect(editor.getText()).toBe("");
		await vi.waitFor(async () => expect((await terminal.screen()).slice(0, 3)).toEqual(["────────", "", "────────"]));
	});

test("vertical movement remembers a column across short lines and scrolls a long draft", () => {
	const { editor } = setup();
	editor.setText("abcdefgh\nx\nabcdefgh");
	editor.render(12);
	editor.handleInput("\x01");
	for (let i = 0; i < 6; i++) editor.handleInput("\x1b[C");
	expect(editor.getCursor()).toEqual({ line: 2, col: 6 });
	editor.handleInput("\x1b[A");
	expect(editor.getCursor()).toEqual({ line: 1, col: 1 });
	editor.handleInput("\x1b[A");
	expect(editor.getCursor()).toEqual({ line: 0, col: 6 });
	editor.setText(Array.from({ length: 12 }, (_, i) => `line${i + 1}`).join("\n"));
	const bottom = editor.render(20).map((line) => stripTerminalSequences(line).trimEnd());
	expect(bottom).toEqual([
		"───── ↑ 7 more ─────",
		" line8",
		" line9",
		" line10",
		" line11",
		" line12",
		"────────────────────",
	]);
	editor.handleInput("\x1b[5~");
	editor.handleInput("\x1b[5~");
	editor.handleInput("\x1b[5~");
	expect(editor.getCursor().line).toBe(0);
	expect(stripTerminalSequences(editor.render(20)[0]!)).toBe("────────────────────");
	expect(editor.getLines().slice(0, 2)).toEqual(["line1", "line2"]);
});

test("clicking wrapped wide text inserts at a grapheme boundary and ignores non-click events", () => {
	const { editor } = setup();
	editor.setText("A界🙂B");
	editor.render(8);
	const click: TuiMouseEvent = {
		type: "click",
		button: "left",
		x: 3,
		y: 1,
		screenX: 3,
		screenY: 1,
		width: 8,
		height: 4,
		shift: false,
		alt: false,
		ctrl: false,
	};
	expect(editor.handleMouse(click)).toEqual({ handled: true, focus: true });
	expect(editor.getCursor()).toEqual({ line: 0, col: 1 });
	editor.insertTextAtCursor("!");
	expect(editor.getText()).toBe("A!界🙂B");
	expect(editor.handleMouse({ ...click, type: "move" })).toBeUndefined();
	expect(editor.handleMouse({ ...click, y: 0 })).toEqual({ handled: true, focus: true });
	editor.setPaddingX(2);
	editor.setAutocompleteMaxVisible(200);
	expect(editor.getPaddingX()).toBe(2);
	expect(editor.getAutocompleteMaxVisible()).toBe(20);
	for (const line of editor.render(10)) expect(visibleWidth(line)).toBe(10);
});

test("character jumps cross logical lines and preserve the draft", () => {
	const { editor } = setup();
	editor.setText("a.b\nc.d");
	editor.render(20);
	editor.handleInput("\x01");
	editor.handleInput("\x1b[A");
	editor.handleInput("\x01");
	editor.handleInput("\x1d");
	editor.handleInput(".");
	expect(editor.getCursor()).toEqual({ line: 0, col: 1 });
	editor.handleInput("\x1d");
	editor.handleInput(".");
	expect(editor.getCursor()).toEqual({ line: 1, col: 1 });
	editor.handleInput("\x1b\x1d");
	editor.handleInput(".");
	expect(editor.getCursor()).toEqual({ line: 0, col: 1 });
	expect(editor.getText()).toBe("a.b\nc.d");
});

test("word navigation crosses logical lines without changing the draft or splitting a paste marker", () => {
	const { editor } = setup();
	editor.setText("one two\nthree");
	editor.render(20);
	for (const cursor of [
		{ line: 1, col: 0 },
		{ line: 0, col: 7 },
		{ line: 0, col: 4 },
		{ line: 0, col: 0 },
		{ line: 0, col: 0 },
	]) {
		editor.handleInput("\x1b[1;5D");
		expect(editor.getCursor()).toEqual(cursor);
	}
	for (const cursor of [
		{ line: 0, col: 3 },
		{ line: 0, col: 7 },
		{ line: 1, col: 0 },
		{ line: 1, col: 5 },
		{ line: 1, col: 5 },
	]) {
		editor.handleInput("\x1b[1;5C");
		expect(editor.getCursor()).toEqual(cursor);
	}
	expect(editor.getText()).toBe("one two\nthree");
	const payload = "line\n".repeat(12);
	editor.setText("");
	editor.handleInput("\x1b[200~" + payload + "\x1b[201~");
	const marker = editor.getText();
	editor.handleInput("\x1b[1;5D");
	expect(editor.getCursor()).toEqual({ line: 0, col: 0 });
	editor.handleInput("\x1b[1;5C");
	expect(editor.getCursor()).toEqual({ line: 0, col: marker.length });
	expect(editor.getExpandedText()).toBe(payload);
});

test("arrow navigation reaches line edges before entering history and restores the draft cursor", () => {
	const { editor } = setup();
	editor.addToHistory("");
	editor.addToHistory("saved");
	editor.setText("draft");
	editor.render(20);
	editor.handleInput("\x1b[A");
	expect(editor.getCursor()).toEqual({ line: 0, col: 0 });
	expect(editor.getText()).toBe("draft");
	editor.handleInput("\x1b[A");
	expect(editor.getText()).toBe("saved");
	editor.handleInput("\x1b[B");
	expect(editor.getText()).toBe("draft");
	expect(editor.getCursor()).toEqual({ line: 0, col: 0 });
	editor.handleInput("\x1b[B");
	expect(editor.getCursor()).toEqual({ line: 0, col: 5 });
	expect(editor.getText()).toBe("draft");
});
