import { stripVTControlCharacters } from "node:util";
import { afterEach, expect, test, vi } from "vitest";
import { Input } from "../src/components/input.ts";
import { Text } from "../src/components/text.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import {
	Container,
	compositeTuiLine,
	isViewportTUI,
	type Component,
	type OverlayAnchor,
	type TuiMouseEvent,
} from "../src/tui.ts";
import type { TerminalColors } from "../src/terminal-colors.ts";
import { visibleWidth } from "../src/utils.ts";
import { TestTerminal } from "./support/terminal.ts";

const resources: { ui: TuiMainScreen | TuiAltScreen; terminal: TestTerminal }[] = [];
afterEach(() => {
	for (const { ui, terminal } of resources.splice(0)) {
		ui.stop();
		terminal.dispose();
	}
	vi.restoreAllMocks();
});
function setup(fullscreen = false) {
	const terminal = new TestTerminal(30, 12);
	const ui = fullscreen ? new TuiAltScreen(terminal) : new TuiMainScreen(terminal);
	resources.push({ ui, terminal });
	return { ui, terminal };
}

test("nested overlays restore the surviving input after hiding their original parent", async () => {
	const { ui, terminal } = setup();
	const draft = new Input(),
		first = new Input(),
		second = new Input();
	ui.addChild(draft);
	ui.setFocus(draft);
	ui.start();
	const parent = ui.showOverlay(first, { row: 1, col: 1, width: 12 });
	const child = ui.showOverlay(second, { row: 3, col: 1, width: 12 });
	terminal.input("child");
	parent.hide();
	parent.hide();
	expect(child.isFocused()).toBe(true);
	child.hide();
	terminal.input("draft");
	expect(second.getValue()).toBe("child");
	expect(first.getValue()).toBe("");
	expect(draft.getValue()).toBe("draft");
	expect(ui.hasOverlay()).toBe(false);
	ui.hideOverlay();
	await vi.waitFor(async () => expect((await terminal.screen())[0]).toBe("> draft"));
});

test("overlay hiding, refocusing and explicit unfocus route input to the requested component", () => {
	const { ui, terminal } = setup();
	const draft = new Input(),
		dialog = new Input();
	ui.addChild(draft);
	ui.setFocus(draft);
	ui.start();
	const handle = ui.showOverlay(dialog);
	handle.setHidden(true);
	handle.setHidden(true);
	expect(handle.isHidden()).toBe(true);
	handle.focus();
	terminal.input("a");
	expect(draft.getValue()).toBe("a");
	handle.setHidden(false);
	terminal.input("b");
	expect(dialog.getValue()).toBe("b");
	handle.unfocus({ target: draft });
	terminal.input("c");
	expect(draft.getValue()).toBe("ac");
	handle.focus();
	terminal.input("d");
	expect(dialog.getValue()).toBe("bd");
	handle.unfocus();
	terminal.input("e");
	expect(draft.getValue()).toBe("ace");
	handle.hide();
	handle.focus();
	expect(handle.getBounds()).toBeUndefined();
	expect(handle.isFocused()).toBe(false);
});

test("a temporary focus blocker can resume either its dialog or an explicitly chosen input", () => {
	for (const explicit of [false, true]) {
		const { ui, terminal } = setup();
		const draft = new Input(),
			temporary = new Input(),
			dialog = new Input();
		ui.addChild(draft);
		ui.addChild(temporary);
		ui.setFocus(draft);
		ui.start();
		const handle = ui.showOverlay(dialog);
		ui.setFocus(temporary);
		terminal.input("temporary");
		if (explicit) handle.unfocus({ target: draft });
		ui.setFocus(null);
		terminal.input("resumed");
		expect(temporary.getValue()).toBe("temporary");
		expect(dialog.getValue()).toBe(explicit ? "" : "resumed");
		expect(draft.getValue()).toBe(explicit ? "resumed" : "");
	}
});

test("temporary focus moves through nested mounted inputs before returning to its overlay", () => {
	const { ui, terminal } = setup();
	const outer = new Container(), inner = new Container();
	const draft = new Input(), first = new Input(), second = new Input(), dialog = new Input();
	outer.addChild(inner);
	for (const input of [draft, first, second]) inner.addChild(input);
	ui.addChild(outer);
	ui.setFocus(draft);
	ui.start();
	const overlay = ui.showOverlay(dialog);
	ui.setFocus(first);
	ui.setFocus(second);
	terminal.input("temporary");
	expect(ui.getFocusedComponent()).toBe(second);
	expect(second.getValue()).toBe("temporary");
	expect(first.focused).toBe(false);
	ui.setFocus(null);
	terminal.input("dialog");
	expect(dialog.getValue()).toBe("dialog");
	overlay.hide();
	terminal.input("draft");
	expect(ui.getFocusedComponent()).toBe(draft);
	expect(draft.getValue()).toBe("draft");
});

test("all overlay anchors honor margins, offsets, height limits and viewport bounds", () => {
	const { ui } = setup();
	const anchors = [
		["top-left", 1, 1],
		["top-center", 1, 11],
		["top-right", 1, 21],
		["left-center", 4, 1],
		["center", 4, 11],
		["right-center", 4, 21],
		["bottom-left", 8, 1],
		["bottom-center", 8, 11],
		["bottom-right", 8, 21],
	] satisfies [OverlayAnchor, number, number][];
	for (const [anchor, row, col] of anchors) {
		const overlay = ui.showOverlay(new Text("one\ntwo\nthree\nfour", 0, 0), {
			anchor,
			margin: 1,
			width: 8,
			maxHeight: 3,
		});
		ui.renderNow();
		expect(overlay.getBounds()).toEqual({ row, col, width: 8, height: 3 });
		overlay.hide();
	}
	const clipped = ui.showOverlay(new Text("one\ntwo\nthree", 0, 0), {
		width: "50%",
		minWidth: 18,
		maxHeight: "25%",
		margin: { top: 2, bottom: 1, left: 2, right: 3 },
		row: 100,
		col: -100,
		offsetY: 5,
		offsetX: -5,
	});
	ui.renderNow();
	expect(clipped.getBounds()).toEqual({ row: 8, col: 2, width: 18, height: 3 });
});

test("viewport visibility returns focus to the draft and noncapturing notices leave input available", async () => {
	const { ui, terminal } = setup(true);
	const draft = new Input(),
		dialog = new Input();
	ui.addChild(draft);
	ui.setFocus(draft);
	ui.start();
	const handle = ui.showOverlay(dialog, { row: 2, width: 10, visible: (width) => width >= 20 });
	terminal.input("dialog");
	terminal.resize(16, 8);
	ui.renderNow();
	terminal.input("draft");
	expect(handle.getBounds()).toBeUndefined();
	expect(ui.hasOverlay()).toBe(false);
	expect(draft.getValue()).toBe("draft");
	terminal.resize(30, 12);
	ui.renderNow();
	terminal.input("!");
	expect(dialog.getValue()).toBe("dialog!");
	handle.hide();
	const notice = ui.showOverlay(new Text("saved", 0, 0), { row: 2, col: 0, width: 10, nonCapturing: true });
	terminal.input("!");
	ui.renderNow();
	expect(draft.getValue()).toBe("draft!");
	expect(notice.isFocused()).toBe(false);
	expect((await terminal.screen())[2]).toContain("saved");
	expect(isViewportTUI(ui)).toBe(true);
	expect(isViewportTUI(new TuiMainScreen(terminal))).toBe(false);
});

test("terminal color queries finish independently, ignore duplicates and preserve incomplete palettes", async () => {
	const { ui, terminal } = setup();
	ui.start();
	const first = ui.queryTerminalColors({ timeoutMs: 1000 });
	const second = ui.queryTerminalColors({ timeoutMs: 1000 });
	terminal.input("\x1b]10;#ff0000\x07");
	terminal.input("\x1b]10;#00ff00\x07");
	terminal.input("\x1b[?1;2c");
	await expect(first).resolves.toEqual({
		foreground: { r: 255, g: 0, b: 0 },
		background: undefined,
		palette: undefined,
	});
	terminal.input("\x1b]10;#ffffff\x07");
	terminal.input("\x1b]11;#000000\x07");
	for (let index = 0; index < 16; index++) terminal.input(`\x1b]4;${index};rgb:${index.toString(16)}/0/f\x07`);
	await expect(second).resolves.toEqual({
		foreground: { r: 255, g: 255, b: 255 },
		background: { r: 0, g: 0, b: 0 },
		palette: Array.from({ length: 16 }, (_, index) => ({ r: index * 17, g: 0, b: 255 })),
	});
	terminal.input("\x1b[?1c");
});

test("timed-out color queries report late replies once without delivering terminal responses as editor input", async () => {
	const { ui, terminal } = setup();
	const draft = new Input();
	ui.addChild(draft);
	ui.setFocus(draft);
	ui.start();
	const late: TerminalColors[] = [];
	const query = ui.queryTerminalColors({ timeoutMs: 1, onLateReply: (colors) => late.push(colors) });
	await expect(query).resolves.toEqual({ foreground: undefined, background: undefined, palette: undefined });
	terminal.input("\x1b]11;#123456\x07");
	terminal.input("\x1b[?1c");
	expect(late).toEqual([{ foreground: undefined, background: { r: 18, g: 52, b: 86 }, palette: undefined }]);
	const abandoned = ui.queryTerminalColors({ timeoutMs: 1 });
	await abandoned;
	terminal.input("\x1b]10;#ffffff\x07");
	terminal.input("\x1b[?1c");
	terminal.input("ready");
	expect(draft.getValue()).toBe("ready");
	expect(late).toHaveLength(1);
});

test("an active color query retains its late callback when caller options change", async () => {
	const { ui, terminal } = setup();
	ui.start();
	const selected = vi.fn((_colors: TerminalColors) => {}),
		replacement = vi.fn((_colors: TerminalColors) => {});
	const options = { timeoutMs: 1, onLateReply: selected };
	const query = ui.queryTerminalColors(options);
	options.onLateReply = replacement;
	await query;
	terminal.input("\x1b]11;#123456\x07");
	terminal.input("\x1b[?1c");
	expect(selected).toHaveBeenCalledExactlyOnceWith({
		foreground: undefined,
		background: { r: 18, g: 52, b: 86 },
		palette: undefined,
	});
	expect(replacement).not.toHaveBeenCalled();
});

test("input filters, terminal notifications and key-release opt-in keep their separate contracts", () => {
	const { ui, terminal } = setup();
	const received: string[] = [],
		schemes: string[] = [];
	const target: Component = { render: () => ["target"], invalidate() {}, handleInput: (data) => received.push(data) };
	ui.addChild(target);
	ui.setFocus(target);
	ui.start();
	const writes = vi.spyOn(terminal, "write");
	ui.setTerminalColorSchemeNotifications(true);
	ui.setTerminalColorSchemeNotifications(true);
	expect(writes.mock.calls.filter(([text]) => text === "\x1b[?2031h")).toHaveLength(1);
	const removeScheme = ui.onTerminalColorSchemeChange((scheme) => schemes.push(scheme));
	terminal.input("\x1b[?997;2n");
	removeScheme();
	terminal.input("\x1b[?997;1n");
	expect(schemes).toEqual(["light"]);
	const remove = ui.addInputListener((data) => ({ data: data === "empty" ? "" : data.toUpperCase() }));
	terminal.input("empty");
	terminal.input("x");
	remove();
	remove();
	const release = "\x1b[97;1:3u";
	terminal.input(release);
	target.wantsKeyRelease = true;
	terminal.input(release);
	expect(received).toEqual(["X", release]);
	let debug = 0;
	ui.onDebug = () => debug++;
	terminal.input("\x1b[100;6u");
	expect(debug).toBe(1);
	ui.setShowHardwareCursor(true);
	ui.setShowHardwareCursor(true);
	expect(ui.getShowHardwareCursor()).toBe(true);
	ui.setShowHardwareCursor(false);
	ui.setClearOnShrink(true);
	expect(ui.getClearOnShrink()).toBe(true);
	ui.setTerminalColorSchemeNotifications(false);
	expect(writes).toHaveBeenCalledWith("\x1b[?2031l");
});

test("containers translate unrendered mouse positions and preserve a composite input's focus ownership", () => {
	class Form extends Container {
		handleInput(_data: string) {}
	}
	const form = new Form(),
		events: TuiMouseEvent[] = [];
	const child: Component = {
		render: () => ["field"],
		invalidate() {},
		handleMouse: (event) => {
			events.push(event);
			return { focus: true };
		},
	};
	form.addChild(new Text("one\ntwo", 0, 0));
	form.addChild(child);
	const mouse: TuiMouseEvent = {
		type: "click",
		button: "left",
		x: 2,
		y: 2,
		screenX: 12,
		screenY: 22,
		width: 20,
		height: 3,
		shift: false,
		alt: false,
		ctrl: false,
	};
	for (const rendered of [false, true]) {
		if (rendered) form.render(20);
		expect(form.handleMouse(mouse)).toMatchObject({
			focusTarget: form,
			target: { component: child, originX: 10, originY: 22, width: 20, height: 1 },
		});
		expect(events.at(-1)).toMatchObject({ x: 2, y: 0, height: 1 });
	}
	for (const y of [-1, 3, 10]) expect(form.handleMouse({ ...mouse, y })).toBeUndefined();
	form.removeChild(child);
	form.removeChild(child);
	form.clear();
	expect(form.render(20)).toEqual([]);
});

test("overlay composition preserves surrounding cells and bounds wide characters and colored text", () => {
	expect(stripVTControlCharacters(compositeTuiLine("abcdefghijk", "XY", 3, 4, 12))).toBe("abcXY  hijk ");
	for (const width of [3, 4, 7, 12]) {
		const line = compositeTuiLine("\x1b[31m界🙂abcdef", "\x1b[32m界XYZ", 1, Math.min(3, width - 1), width);
		expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		expect(line).toContain("\x1b[0m");
	}
});
