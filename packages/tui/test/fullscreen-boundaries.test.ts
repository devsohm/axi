import { afterEach, expect, test, vi } from "vitest";
import { Input } from "../src/components/input.ts";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import { VStack } from "../src/components/v-stack.ts";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "../src/keybindings.ts";
import { getCapabilities, resetCapabilitiesCache, setCapabilities } from "../src/terminal-image.ts";
import { TuiAltScreen, type TuiAltScreenOptions } from "../src/tui-alt-screen.ts";
import type { Component, TuiMouseEvent } from "../src/tui.ts";
import { stripTerminalSequences } from "../src/utils.ts";
import { TestTerminal } from "./support/terminal.ts";

const resources: { ui: TuiAltScreen; terminal: TestTerminal }[] = [];
afterEach(() => {
	for (const { ui, terminal } of resources.splice(0)) {
		ui.stop({ preserveScreen: true });
		terminal.dispose();
	}
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	resetCapabilitiesCache();
	setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
});
function setup(options: TuiAltScreenOptions = {}, width = 48, height = 10) {
	const terminal = new TestTerminal(width, height),
		ui = new TuiAltScreen(terminal, false, undefined, options);
	resources.push({ ui, terminal });
	return { ui, terminal };
}
const rows = Array.from({ length: 50 }, (_, row) => `row ${row}`).join("\n");
const mouse = (button: number, x: number, y: number, release = false) =>
	`\x1b[<${button};${x + 1};${y + 1}${release ? "m" : "M"}`;

test.each(["direct", "tmux", "screen", "disabled"] as const)(
	"fullscreen %s mouse mode is balanced across repeated starts and stops",
	async (mode) => {
		for (const name of ["TMUX", "STY", "ZELLIJ", "TERM"]) vi.stubEnv(name, undefined);
		if (mode === "tmux") vi.stubEnv("TERM", "tmux-256color");
		if (mode === "screen") vi.stubEnv("STY", "managed-session");
		setCapabilities({ images: null, trueColor: true, hyperlinks: true });
		const { ui, terminal } = setup({ mouse: mode !== "disabled" }),
			writes = vi.spyOn(terminal, "write");
		ui.addChild(new Text("content", 0, 0));
		for (let iteration = 0; iteration < 2; iteration++) {
			writes.mockClear();
			ui.start();
			ui.renderNow();
			const started = writes.mock.calls.map(([data]) => data).join("");
			expect(started).toContain("\x1b[?1049h");
			expect(started.includes("\x1b[?1000h")).toBe(mode !== "disabled");
			expect(started.includes("\x1b[?1003h")).toBe(mode === "direct");
			ui.stop({ preserveScreen: true });
			const stopped = writes.mock.calls.map(([data]) => data).join("");
			expect(stopped).toContain("\x1b[?1049l");
			expect(stopped).toContain("\x1b[?7h");
			expect(stopped.includes("\x1b[?1000l")).toBe(mode !== "disabled");
			await terminal.screen();
		}
	},
);

test("fullscreen temporarily disables iTerm images and restores the complete capability object", async () => {
	const capabilities = { images: "iterm2", trueColor: false, hyperlinks: true } as const;
	setCapabilities(capabilities);
	const { ui, terminal } = setup(),
		invalidated = vi.fn();
	ui.addChild({ render: () => ["image fallback"], invalidate: invalidated });
	ui.start();
	ui.renderNow();
	expect(getCapabilities()).toEqual({ ...capabilities, images: null });
	expect(invalidated).toHaveBeenCalled();
	ui.stop({ preserveScreen: true });
	expect(getCapabilities()).toEqual(capabilities);
	await terminal.screen();
});

test("screen snapshots are detached copies and explicit layouts own their invalidation", async () => {
	const { ui, terminal } = setup();
	const child = { render: () => ["children"], invalidate: vi.fn() },
		root = { render: () => ["layout"], invalidate: vi.fn() };
	ui.addChild(child);
	ui.setLayoutRoot(root);
	ui.start();
	ui.renderNow();
	const screen = ui.getScreenLines();
	expect(stripTerminalSequences(screen[0]!)).toContain("layout");
	screen[0] = "mutated caller copy";
	expect(ui.getScreenLines()[0]).not.toBe(screen[0]);
	ui.invalidate();
	expect(root.invalidate).toHaveBeenCalledOnce();
	expect(child.invalidate).not.toHaveBeenCalled();
	ui.setLayoutRoot(undefined);
	ui.invalidate();
	ui.renderNow();
	expect(child.invalidate).toHaveBeenCalledOnce();
	expect((await terminal.screen())[0]).toBe("children");
});

test("captured mouse drags retain component coordinates outside its bounds and suppress click synthesis", async () => {
	const { ui, terminal } = setup();
	const events: TuiMouseEvent[] = [],
		inputs: string[] = [];
	const button: Component = {
		render: () => ["button"],
		invalidate() {},
		handleInput: (data) => inputs.push(data),
		handleMouse: (event) => {
			events.push(event);
			return { handled: true, capture: event.type === "press", focus: event.type === "press" };
		},
	};
	ui.setLayoutRoot(
		new VStack([
			{ component: new Text("heading", 0, 0), basis: 1 },
			{ component: button, basis: 1 },
		]),
	);
	ui.start();
	ui.renderNow();
	terminal.input(mouse(0, 2, 1));
	terminal.input(mouse(32, 30, 8));
	terminal.input(mouse(0, 30, 8, true));
	terminal.input("typed");
	expect(events.map((event) => [event.type, event.x, event.y])).toEqual([
		["press", 2, 0],
		["drag", 30, 7],
		["release", 30, 7],
	]);
	expect(inputs).toEqual(["typed"]);
	expect(ui.hasActiveSelection()).toBe(false);
	terminal.input(mouse(0, 2, 1));
	terminal.input(mouse(0, 2, 1, true));
	terminal.input(mouse(0, 2, 1));
	terminal.input(mouse(0, 2, 1, true));
	expect(events.filter((event) => event.type === "click").map((event) => event.clickCount)).toEqual([1, 2]);
	await terminal.screen();
});

for (const primary of ["inner", "outer"] as const)
	test.each(["chain", "contain"] as const)(
		`nested wheel scrolling honors %s with the ${primary} primary view`,
		async (overscroll) => {
			const { ui, terminal } = setup({ wheelScrollLines: 1 });
			const inner = new ScrollView(new Text(rows, 0, 0), { overscroll, primary: primary === "inner" });
			const outer = new ScrollView(
				new VStack([
					{ component: inner, basis: 3, shrink: 0 },
					{ component: new Text(rows, 0, 0), basis: 50, shrink: 0 },
				]),
				{ primary: primary === "outer" },
			);
			ui.setLayoutRoot(outer);
			ui.start();
			ui.renderNow();
			inner.scrollToEnd();
			ui.renderNow();
			terminal.input(mouse(65, 3, 1));
			ui.renderNow();
			expect(inner.scrollTop).toBe(47);
			expect(outer.scrollTop).toBe(overscroll === "chain" || primary === "outer" ? 1 : 0);
			await terminal.screen();
		},
	);

test("selection auto-scrolls only while a drag remains at the viewport edge", async () => {
	const copied: string[] = [];
	const { ui, terminal } = setup({
		copyOnSelect: false,
		copySelection: async (text) => {
			copied.push(text);
			return true;
		},
	});
	ui.addChild(new Text(rows, 0, 0));
	ui.start();
	ui.renderNow();
	ui.scrollToTop();
	ui.renderNow();
	await terminal.screen();
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
	terminal.input(mouse(0, 0, 0));
	terminal.input(mouse(32, 10, 9));
	await vi.advanceTimersByTimeAsync(150);
	ui.renderNow();
	expect(ui.viewportTop).toBe(3);
	terminal.input(mouse(0, 10, 9, true));
	await vi.advanceTimersByTimeAsync(200);
	ui.renderNow();
	expect(ui.viewportTop).toBe(3);
	expect(await ui.copyActiveSelectionToClipboard()).toBe(true);
	expect(copied[0]).toContain("row 0");
	expect(copied[0]).toContain("row 12");
	vi.useRealTimers();
	await terminal.screen();
});

test("the follow-output indicator returns a scrolled transcript to its latest rows", async () => {
	const { ui, terminal } = setup({ scrollToEndIndicator: () => "Follow output" });
	ui.addChild(new Text(rows, 0, 0));
	ui.start();
	ui.renderNow();
	ui.scrollToTop();
	ui.renderNow();
	const screen = await terminal.screen();
	const row = screen.findIndex((line) => line.includes("Follow output")),
		col = screen[row]!.indexOf("Follow output");
	expect(row).toBe(9);
	terminal.input(mouse(0, col + 1, row));
	ui.renderNow();
	expect(ui.isFollowingOutput).toBe(true);
	expect(ui.viewportTop).toBe(40);
	expect((await terminal.screen()).join("\n")).not.toContain("Follow output");
});

test("search mouse controls navigate and clearing the query removes stale results without changing the draft", async () => {
	setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, { "tui.altScreen.search": "ctrl+f" }));
	const { ui, terminal } = setup({}, 80, 14),
		draft = new Input();
	ui.addChild(new Text("needle first\nneedle second\nneedle third", 0, 0));
	ui.addChild(draft);
	ui.setFocus(draft);
	ui.start();
	ui.renderNow();
	terminal.input("\x06");
	terminal.input("needle");
	ui.renderNow();
	const screen = await terminal.screen(),
		row = screen.findIndex((line) => line.includes("↓")),
		column = screen[row]!.indexOf("↓");
	expect(screen.join("\n")).toContain("1/3");
	terminal.input(mouse(35, column, row));
	terminal.input(mouse(0, column, row));
	ui.renderNow();
	expect((await terminal.screen()).join("\n")).toContain("2/3");
	terminal.input("\x15");
	ui.renderNow();
	expect((await terminal.screen()).join("\n")).not.toContain("2/3");
	terminal.input("\x06");
	terminal.input("draft");
	expect(draft.getValue()).toBe("draft");
});
