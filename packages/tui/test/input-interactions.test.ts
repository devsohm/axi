import { afterEach, expect, test } from "vitest";
import { Input } from "../src/components/input.ts";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "../src/keybindings.ts";
import type { TuiMouseEvent } from "../src/tui.ts";
import { stripTerminalSequences as stripAnsi, visibleWidth } from "../src/utils.ts";

afterEach(() => setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS)));

function press(input: Input, ...keys: string[]): string {
	for (const key of keys) input.handleInput(key);
	return input.getValue();
}

test("single-line editing deletes complete graphemes in both directions and restores undo", () => {
	const input = new Input();
	expect(press(input, "A", "👩‍💻", "é", "界")).toBe("A👩‍💻é界");
	expect(press(input, "\x1b[D", "\x7f")).toBe("A👩‍💻界");
	expect(press(input, "\x1f")).toBe("A👩‍💻é界");
	expect(press(input, "\x01", "\x1b[C", "\x04")).toBe("Aé界");
	expect(press(input, "\x05", "\x04")).toBe("Aé界");
	expect(press(input, "\x01", "\x7f", "\x1b[D", "!")).toBe("!Aé界");
});

test("word and line kills accumulate, rotate through the kill ring and undo", () => {
	const input = new Input();
	expect(press(input, "red green blue", "\x17", "\x17")).toBe("red ");
	expect(press(input, "\x19")).toBe("red green blue");
	expect(press(input, "\x01", "\x1bd")).toBe(" green blue");
	expect(press(input, "\x19")).toBe("red green blue");
	expect(press(input, "\x1by")).toBe("green blue green blue");
	expect(press(input, "\x1f")).toBe("red green blue");
	expect(press(input, "\x05", "\x1bb", "\x0b")).toBe("red green ");
	expect(press(input, "\x01", "\x1bf", "\x15")).toBe(" green ");
	expect(press(input, "\x1f")).toBe("red green ");
});

test("fragmented paste is one undo operation, strips newlines and processes its remaining keys", () => {
	const input = new Input();
	const events: string[] = [];
	input.onSubmit = (value) => events.push(`submit:${value}`);
	input.onEscape = () => events.push("escape");
	expect(press(input, "start ", "\x1b[200~x\r\ny\t")).toBe("start ");
	expect(press(input, "z\x1b[201~\r")).toBe("start xy    z");
	expect(events).toEqual(["submit:start xy    z"]);
	expect(press(input, "\x1f")).toBe("start ");
	press(input, "\x1b", "\n", "\x1b[999~");
	expect(events).toEqual(["submit:start xy    z", "escape", "submit:start "]);
	expect(input.getValue()).toBe("start ");
});

test("custom bindings and Kitty printable keys edit and submit the same draft", () => {
	setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, { "tui.input.submit": "ctrl+s" }));
	const input = new Input();
	const submitted: string[] = [];
	input.onSubmit = (value) => submitted.push(value);
	press(input, "\x1b[97u", "\x1b[98u", "\x13");
	expect(input.getValue()).toBe("ab");
	expect(submitted).toEqual(["ab"]);
	input.setValue("q");
	expect(press(input, "!")).toBe("q!");
});

test("rendering clips prompts and scrolls around the cursor without splitting wide text", () => {
	const input = new Input({ prompt: "? ", placeholder: "Ask here" });
	input.focused = true;
	expect(stripAnsi(input.render(8)[0]!)).toBe("? Ask he");
	expect(input.render(1).map(stripAnsi)).toEqual(["?"]);
	press(input, "abcdefghij");
	expect(stripAnsi(input.render(8)[0]!)).toBe("? fghij ");
	press(input, "\x01");
	expect(stripAnsi(input.render(8)[0]!)).toBe("? abcdef");
	press(input, "\x1bf");
	expect(stripAnsi(input.render(8)[0]!)).toBe("? fghij ");
	input.setValue("界🙂abcd");
	for (const width of [2, 3, 4, 8]) expect(visibleWidth(input.render(width)[0]!)).toBe(width);
});

test("mouse clicks position insertion at grapheme boundaries in the visible window", () => {
	const input = new Input();
	press(input, "界🙂abc");
	input.render(20);
	const event: TuiMouseEvent = {
		type: "press",
		button: "left",
		x: 4,
		y: 0,
		screenX: 4,
		screenY: 0,
		width: 20,
		height: 1,
		shift: false,
		alt: false,
		ctrl: false,
	};
	expect(input.handleMouse(event)).toEqual({ handled: true, focus: true });
	expect(press(input, "!")).toBe("界!🙂abc");
	expect(input.handleMouse({ ...event, y: 1 })).toBeUndefined();
	expect(input.handleMouse({ ...event, button: "right" })).toBeUndefined();
	input.handleMouse({ ...event, x: 19 });
	expect(press(input, "?")).toBe("界!🙂abc?");
});
