import { afterEach, expect, test } from "vitest";
import { Editor } from "../src/components/editor.ts";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "../src/keybindings.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { visibleWidth } from "../src/utils.ts";
import { TestTerminal } from "./support/terminal.ts";

const plain = (value: string) => value;
const theme = {
	borderColor: plain,
	selectList: { selectedPrefix: plain, selectedText: plain, description: plain, scrollInfo: plain, noMatch: plain },
};
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
afterEach(() => setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS)));

test.each([1, 7, 42, 1009])("Unicode editing agrees with a plain-text model through 400 actions, seed %s", (seed) => {
	const terminal = new TestTerminal(40, 20),
		editor = new Editor(new TuiMainScreen(terminal), theme);
	let randomState = seed,
		text = "",
		cursor = 0;
	const random = (bound: number) => {
		randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
		return randomState % bound;
	};
	const atoms = ["a", "Z", "界", "🙂", "e\u0301", "👩‍💻", " ", "\n", "\t"];
	const actions = ["left", "right", "backspace", "delete", "home", "end", "insert", "insert", "insert"] as const;
	try {
		for (let step = 0; step < 400; step++) {
			const action = actions[random(actions.length)];
			const before = text.slice(0, cursor),
				after = text.slice(cursor);
			const previous = [...segmenter.segment(before)].at(-1)?.segment.length ?? 0;
			const following = [...segmenter.segment(after)][0]?.segment.length ?? 0;
			if (action === "insert") {
				const raw = atoms[random(atoms.length)]!;
				const inserted = raw === "\t" ? "    " : raw;
				editor.insertTextAtCursor(raw);
				text = before + inserted + after;
				cursor += inserted.length;
			} else if (action === "left") {
				editor.handleInput("\x1b[D");
				cursor -= previous;
			} else if (action === "right") {
				editor.handleInput("\x1b[C");
				cursor += following;
			} else if (action === "backspace") {
				editor.handleInput("\x7f");
				text = before.slice(0, before.length - previous) + after;
				cursor -= previous;
			} else if (action === "delete") {
				editor.handleInput("\x1b[3~");
				text = before + after.slice(following);
			} else if (action === "home") {
				editor.handleInput("\x01");
				cursor = before.lastIndexOf("\n") + 1;
			} else {
				editor.handleInput("\x05");
				const newline = text.indexOf("\n", cursor);
				cursor = newline < 0 ? text.length : newline;
			}
			const lines = text.slice(0, cursor).split("\n");
			expect(editor.getText(), `text after ${step}: ${action}`).toBe(text);
			expect(editor.getCursor(), `cursor after ${step}: ${action}`).toEqual({
				line: lines.length - 1,
				col: lines.at(-1)!.length,
			});
			if (step % 25 === 0) {
				const width = 6 + random(30);
				for (const row of editor.render(width)) expect(visibleWidth(row)).toBe(width);
			}
		}
	} finally {
		terminal.dispose();
	}
});
