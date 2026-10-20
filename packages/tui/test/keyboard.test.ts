import { afterEach, describe, expect, it } from "vitest";
import { KeybindingsManager, TUI_KEYBINDINGS } from "../src/keybindings.ts";
import { decodePrintableKey, matchesKey, parseKey, setKittyProtocolActive } from "../src/keys.ts";
import { parseKeyboardProtocolNegotiationSequence, resolveEscapeTimeoutMs } from "../src/terminal.ts";

afterEach(() => setKittyProtocolActive(false));

describe("keyboard identity", () => {
	it("keeps uppercase text separate from an unmodified lowercase binding", () => {
		expect(matchesKey("A", "a")).toBe(false);
		expect(matchesKey("A", "shift+a")).toBe(true);
		expect(matchesKey("\x1b[65;2u", "shift+a")).toBe(true);
	});

	it("uses an alternate layout only when the reported character is not authoritative", () => {
		expect(matchesKey("\x1b[1089::99;5u", "ctrl+c")).toBe(true);
		expect(matchesKey("\x1b[107::118;5u", "ctrl+v")).toBe(false);
		expect(parseKey("\x1b[107::118;5u")).toBe("ctrl+k");
	});

	it("changes ambiguous Enter interpretation with protocol negotiation", () => {
		expect(matchesKey("\x1b\r", "alt+enter")).toBe(true);
		setKittyProtocolActive(true);
		expect(matchesKey("\x1b\r", "alt+enter")).toBe(false);
		expect(matchesKey("\x1b\r", "shift+enter")).toBe(true);
		expect(matchesKey("\x1b\x1b", "ctrl+alt+[")).toBe(false);
	});

	it("decodes keypad text and rejects command-modified text", () => {
		expect(decodePrintableKey("\x1b[57399u")).toBe("0");
		expect(decodePrintableKey("\x1b[27;2;65~")).toBe("A");
		expect(decodePrintableKey("\x1b[97;5u")).toBeUndefined();
	});
});

describe("terminal negotiation", () => {
	it("recognizes protocol reports without accepting ordinary key input", () => {
		expect(parseKeyboardProtocolNegotiationSequence("\x1b[?7u")).toEqual({ type: "kitty-flags", flags: 7 });
		expect(parseKeyboardProtocolNegotiationSequence("\x1b[?1;2c")).toEqual({ type: "device-attributes" });
		expect(parseKeyboardProtocolNegotiationSequence("\x1b[97u")).toBeUndefined();
	});

	it("uses the product timeout setting and gives SSH more time", () => {
		expect(resolveEscapeTimeoutMs({ AXI_TUI_ESC_TIMEOUT: "80" })).toBe(80);
		expect(resolveEscapeTimeoutMs({ AXI_TUI_ESC_TIMEOUT: "-1" })).toBe(10);
		expect(resolveEscapeTimeoutMs({ SSH_TTY: "/dev/pts/1" })).toBe(100);
	});
});

describe("keybinding configuration", () => {
	it("preserves other actions when one action is rebound", () => {
		const manager = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.input.submit": "ctrl+s" });
		expect(manager.matches("\r", "tui.select.confirm")).toBe(true);
		expect(manager.matches("\r", "tui.input.submit")).toBe(false);
		expect(manager.matches("\x13", "tui.input.submit")).toBe(true);
	});
});

it("normalizes legacy terminal keys and explicit modifier reports through one public identity contract", () => {
	const cases = [
		["\x1b[A", "up"],
		["\x1b[B", "down"],
		["\x1b[C", "right"],
		["\x1b[D", "left"],
		["\x1b[H", "home"],
		["\x1b[F", "end"],
		["\x1b[2~", "insert"],
		["\x1b[3~", "delete"],
		["\x1b[5~", "pageUp"],
		["\x1b[6~", "pageDown"],
		["\x1bOP", "f1"],
		["\x1bOQ", "f2"],
		["\x1bOR", "f3"],
		["\x1bOS", "f4"],
		["\x1b[15~", "f5"],
		["\x1b[17~", "f6"],
		["\x1b[18~", "f7"],
		["\x1b[19~", "f8"],
		["\x1b[20~", "f9"],
		["\x1b[21~", "f10"],
		["\x1b[23~", "f11"],
		["\x1b[24~", "f12"],
		["\x1b[Z", "shift+tab"],
		["\x1b[1;5D", "ctrl+left"],
		["\x1b[1;3C", "alt+right"],
		["\x1b[1;2A", "shift+up"],
		["\x1b[97;7u", "ctrl+alt+a"],
		["\x1b[97;6u", "ctrl+shift+a"],
		["\x1b[27;5;120~", "ctrl+x"],
		["\x7f", "backspace"],
		["\t", "tab"],
		["\r", "enter"],
	] as const;
	for (const [bytes, key] of cases) {
		expect(matchesKey(bytes, key), key).toBe(true);
		expect(parseKey(bytes), key).toBe(key === "ctrl+shift+a" ? "shift+ctrl+a" : key);
		expect(matchesKey(bytes, "ctrl+alt+shift+f12"), key).toBe(false);
	}
});

it("keeps private-use characters literal in modifyOtherKeys while decoding Kitty keypad keys", () => {
	expect(decodePrintableKey("\x1b[27;1;57399~")).toBe("\ue037");
	expect(decodePrintableKey("\x1b[27;2;57417~")).toBe("\ue049");
	expect(decodePrintableKey("\x1b[57399u")).toBe("0");
	expect(decodePrintableKey("\x1b[57417u")).toBeUndefined();
});
