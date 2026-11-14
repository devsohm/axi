import { afterEach, expect, test } from "vitest";
import { Text } from "../src/components/text.ts";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "../src/keybindings.ts";
import { resetCapabilitiesCache, setCapabilities } from "../src/terminal-image.ts";
import { TuiAltScreen, type TuiAltScreenOptions } from "../src/tui-alt-screen.ts";
import type { Component } from "../src/tui.ts";
import { stripTerminalSequences, visibleWidth } from "../src/utils.ts";
import { TestTerminal } from "./support/terminal.ts";

const resources: { ui: TuiAltScreen; terminal: TestTerminal }[] = [];
afterEach(() => {
	for (const { ui, terminal } of resources.splice(0)) {
		ui.stop({ preserveScreen: true });
		terminal.dispose();
	}
	setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
	resetCapabilitiesCache();
});
function setup(options: TuiAltScreenOptions = {}) {
	setCapabilities({ images: null, trueColor: true, hyperlinks: true });
	const terminal = new TestTerminal(80, 10),
		ui = new TuiAltScreen(terminal, false, undefined, options);
	resources.push({ ui, terminal });
	return { ui, terminal };
}
const lines = Array.from({ length: 40 }, (_, row) => ([2, 10, 20].includes(row) ? `needle ${row}` : `row ${row}`));
const mouse = (button: number, x: number, y: number, release = false) =>
	`\x1b[<${button};${x + 1};${y + 1}${release ? "m" : "M"}`;

test.each(["SGR", "X10"] as const)(
	"%s vertical wheels scroll while horizontal wheels do not move the viewport",
	async (encoding) => {
		const { ui, terminal } = setup({ wheelScrollLines: 1 });
		ui.addChild(new Text(lines.join("\n"), 0, 0));
		ui.start();
		ui.renderNow();
		ui.scrollToTop();
		ui.renderNow();
		const wheel = (button: number) =>
			encoding === "SGR" ? mouse(button, 2, 2) : "\x1b[M" + String.fromCharCode(button + 32, 35, 35);
		terminal.input(wheel(65));
		ui.renderNow();
		expect(ui.viewportTop).toBe(1);
		terminal.input(wheel(64));
		ui.renderNow();
		expect(ui.viewportTop).toBe(0);
		terminal.input(wheel(66));
		terminal.input(wheel(67));
		ui.renderNow();
		expect(ui.viewportTop).toBe(0);
		expect((await terminal.screen())[0]).toBe("row 0");
	},
);

test("search after the final match wraps to the first and navigation wraps in both directions", async () => {
	setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, { "tui.altScreen.search": "ctrl+f" }));
	const { ui, terminal } = setup();
	ui.addChild(new Text(lines.join("\n"), 0, 0));
	ui.start();
	ui.renderNow();
	expect(ui.viewportTop).toBe(30);
	terminal.input("\x06");
	terminal.input("needle");
	ui.renderNow();
	expect((await terminal.screen()).join("\n")).toContain("1/3");
	expect(ui.viewportTop).toBe(0);
	for (const [key, result] of [
		["\r", "2/3"],
		["\x1b[13;2u", "1/3"],
		["\x1b[13;2u", "3/3"],
		["\r", "1/3"],
	] satisfies [string, string][]) {
		terminal.input(key);
		ui.renderNow();
		expect((await terminal.screen()).join("\n")).toContain(result);
	}
	terminal.input("\x15");
	terminal.input("absent");
	terminal.input("\r");
	ui.renderNow();
	expect((await terminal.screen()).join("\n")).toContain("No matches");
	terminal.input("\x1b");
	ui.renderNow();
	expect((await terminal.screen()).join("\n")).not.toContain("No matches");
});

test("streaming a changed search corpus updates counts without moving the viewport", async () => {
	setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, { "tui.altScreen.search": "ctrl+f" }));
	const { ui, terminal } = setup(),
		text = new Text(lines.join("\n"), 0, 0);
	ui.addChild(text);
	ui.start();
	ui.renderNow();
	ui.scrollToTop();
	ui.renderNow();
	terminal.input("\x06");
	terminal.input("needle");
	ui.renderNow();
	terminal.input("\r");
	ui.renderNow();
	expect((await terminal.screen()).join("\n")).toContain("2/3");
	const top = ui.viewportTop;
	const changed = [...lines];
	changed[10] = "removed match";
	text.setText(changed.join("\n"));
	ui.requestRender();
	ui.renderNow();
	expect((await terminal.screen()).join("\n")).toContain("2/2");
	expect(ui.viewportTop).toBe(top);
});

test("several matches on one styled row retain cell positions while the selected match changes", async () => {
	setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, { "tui.altScreen.search": "ctrl+f" }));
	const { ui, terminal } = setup({
		searchMatchStyle: (text) => `\x1b[4m${text}\x1b[24m`,
		searchCurrentMatchStyle: (text) => `\x1b[7m${text}\x1b[27m`,
	});
	ui.addChild(new Text("猫 needle \x1b[31mneedle\x1b[39m needle", 0, 0));
	ui.start();
	ui.renderNow();
	terminal.input("\x06");
	terminal.input("needle");
	ui.renderNow();
	for (const selected of [1, 2, 3]) {
		const screen = await terminal.screen();
		expect(screen[0]).toBe("猫 needle needle needle");
		expect(screen.join("\n")).toContain(`${selected}/3`);
		const raw = ui.getScreenLines()[0]!;
		expect(raw.match(/\x1b\[7m/g)).toHaveLength(1);
		expect(raw.match(/\x1b\[4m/g)).toHaveLength(2);
		terminal.input("\r");
		ui.renderNow();
	}
});

test("components that capture viewport input receive paging keys until focus is released", async () => {
	const { ui, terminal } = setup(),
		received: string[] = [];
	const input: Component = {
		capturesViewportInput: true,
		render: () => ["input"],
		invalidate() {},
		handleInput(data) {
			received.push(data);
		},
	};
	ui.addChild(new Text(lines.join("\n"), 0, 0));
	ui.addChild(input);
	ui.setFocus(input);
	ui.start();
	ui.renderNow();
	ui.scrollToTop();
	ui.scrollBy(10);
	ui.renderNow();
	terminal.input("\x1b[5~");
	ui.renderNow();
	expect(ui.viewportTop).toBe(10);
	expect(received).toEqual(["\x1b[5~"]);
	ui.setFocus(null);
	terminal.input("\x1b[5~");
	ui.renderNow();
	expect(ui.viewportTop).toBe(4);
	await terminal.screen();
});

test("oversized styled component output is clipped at whole terminal cells through resize", async () => {
	const { ui, terminal } = setup();
	const root: Component = { render: () => ["\x1b[31m" + "界".repeat(100) + "\x1b[0m"], invalidate() {} };
	ui.setLayoutRoot(root);
	ui.start();
	ui.renderNow();
	expect(stripTerminalSequences(ui.getScreenLines()[0]!)).toBe("界".repeat(40));
	terminal.resize(7, 10);
	ui.renderNow();
	expect(visibleWidth(ui.getScreenLines()[0]!)).toBeLessThanOrEqual(7);
	expect((await terminal.screen())[0]).toBe("界界界");
	ui.setLayoutRoot(root);
	ui.renderNow();
	expect((await terminal.screen())[0]).toBe("界界界");
});

test("a completed selection survives focus changes and remains explicitly copyable", async () => {
	const copied: string[] = [];
	const { ui, terminal } = setup({
		copyOnSelect: false,
		copySelection: async (text) => {
			copied.push(text);
			return true;
		},
	});
	ui.addChild(new Text("alpha beta", 0, 0));
	ui.start();
	ui.renderNow();
	terminal.input(mouse(0, 0, 0));
	terminal.input(mouse(32, 4, 0));
	terminal.input(mouse(0, 4, 0, true));
	terminal.input("\x1b[O");
	terminal.input("\x1b[I");
	expect(ui.hasActiveSelection()).toBe(true);
	expect(await ui.copyActiveSelectionToClipboard()).toBe(true);
	expect(copied).toEqual(["alpha"]);
	await terminal.screen();
});
