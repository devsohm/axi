import { afterEach, expect, test, vi } from "vitest";
import { Text } from "../src/components/text.ts";
import { ScrollView } from "../src/components/scroll-view.ts";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "../src/keybindings.ts";
import { TuiAltScreen, type TuiAltScreenOptions } from "../src/tui-alt-screen.ts";
import { hyperlink } from "../src/terminal-image.ts";
import { TestTerminal } from "./support/terminal.ts";

const resources: { ui: TuiAltScreen; terminal: TestTerminal }[] = [];
afterEach(() => {
	for (const { ui, terminal } of resources.splice(0)) {
		ui.stop();
		terminal.dispose();
	}
	setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
});
function setup(text: string, options: TuiAltScreenOptions = {}) {
	const terminal = new TestTerminal(24, 8),
		ui = new TuiAltScreen(terminal, undefined, undefined, options),
		transcript = new Text(text, 0, 0);
	resources.push({ ui, terminal });
	ui.addChild(transcript);
	return { ui, terminal, transcript };
}
const rows = Array.from({ length: 30 }, (_, i) => `row${i + 1}`).join("\n");

test("fullscreen keyboard navigation scrolls by lines and pages and finds semantic prompt markers", async () => {
	setKeybindings(
		new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.altScreen.halfPageDown": "alt+v",
			"tui.altScreen.halfPageUp": "alt+u",
			"tui.altScreen.lineDown": "alt+j",
			"tui.altScreen.lineUp": "alt+k",
		}),
	);
	const marked = rows
		.split("\n")
		.map((line, i) => (i % 10 === 0 ? "\x1b]133;A\x07" + line : line))
		.join("\n");
	const { ui, terminal } = setup(marked);
	ui.start();
	await vi.waitFor(() => expect(ui.viewportTop).toBe(22));
	expect(ui.isFollowingOutput).toBe(true);
	terminal.input("\x1b[1;5H");
	await vi.waitFor(() => expect(ui.viewportTop).toBe(0));
	terminal.input("\x1bv");
	terminal.input("\x1bj");
	await vi.waitFor(() => expect(ui.viewportTop).toBe(5));
	terminal.input("\x1bu");
	terminal.input("\x1bk");
	await vi.waitFor(() => expect(ui.viewportTop).toBe(0));
	terminal.input("\x1b[6~");
	await vi.waitFor(() => expect(ui.viewportTop).toBe(4));
	terminal.input("\x1b[1;5B");
	await vi.waitFor(() => expect(ui.viewportTop).toBe(10));
	terminal.input("\x1b[1;5A");
	await vi.waitFor(() => expect(ui.viewportTop).toBe(0));
	terminal.input("\x1b[1;5F");
	await vi.waitFor(() => expect(ui.viewportTop).toBe(22));
	expect(ui.isFollowingOutput).toBe(true);
});

test("mouse wheel settings take effect immediately and Alt multiplies the requested scroll", async () => {
	const { ui, terminal } = setup(rows, { wheelScrollLines: 1 });
	ui.start();
	await vi.waitFor(() => expect(ui.viewportTop).toBe(22));
	ui.scrollToTop();
	await vi.waitFor(() => expect(ui.viewportTop).toBe(0));
	terminal.input("\x1b[<65;8;4M");
	await vi.waitFor(() => expect(ui.viewportTop).toBe(1));
	terminal.input("\x1b[<73;8;4M");
	await vi.waitFor(() => expect(ui.viewportTop).toBe(6));
	ui.setWheelScrollLines(3);
	terminal.input("\x1b[<65;8;4M");
	await vi.waitFor(() => expect(ui.viewportTop).toBe(9));
	await vi.waitFor(async () => expect((await terminal.screen())[0]).toBe("row10"));
	ui.scrollToBottom();
	await vi.waitFor(() => expect(ui.viewportTop).toBe(22));
	ui.scrollBy(-2);
	await vi.waitFor(() => expect(ui.viewportTop).toBe(20));
	expect(ui.isFollowingOutput).toBe(false);
});

test("selection can be copied explicitly while automatic copying is disabled", async () => {
	const copied: string[] = [];
	const { ui, terminal } = setup("alpha beta\nsecond line", {
		copyOnSelect: false,
		copySelection: async (text) => {
			copied.push(text);
			return true;
		},
	});
	ui.start();
	await vi.waitFor(async () => expect((await terminal.screen())[0]).toBe("alpha beta"));
	expect(ui.getCopyOnSelect()).toBe(false);
	terminal.input("\x1b[<0;1;1M");
	terminal.input("\x1b[<32;5;1M");
	terminal.input("\x1b[<0;5;1m");
	expect(ui.hasActiveSelection()).toBe(true);
	expect(copied).toEqual([]);
	expect(await ui.copyActiveSelectionToClipboard()).toBe(true);
	expect(copied).toEqual(["alpha"]);
	ui.resetTextSelection();
	expect(await ui.copyActiveSelectionToClipboard()).toBe(false);
	ui.setCopyOnSelect(true);
	terminal.input("\x1b[<0;7;1M");
	terminal.input("\x1b[<32;10;1M");
	terminal.input("\x1b[<0;10;1m");
	await vi.waitFor(() => expect(copied).toEqual(["alpha", "beta"]));
});

test("losing terminal focus cancels an in-progress selection instead of copying it", async () => {
	const copied: string[] = [];
	const { ui, terminal } = setup("alpha beta", {
		copySelection: async (text) => {
			copied.push(text);
			return true;
		},
	});
	ui.start();
	await vi.waitFor(async () => expect((await terminal.screen())[0]).toBe("alpha beta"));
	terminal.input("\x1b[<0;1;1M");
	terminal.input("\x1b[<32;5;1M");
	expect(ui.hasActiveSelection()).toBe(true);
	terminal.input("\x1b[O");
	terminal.input("\x1b[<0;5;1m");
	terminal.input("\x1b[I");
	expect(ui.hasActiveSelection()).toBe(false);
	expect(copied).toEqual([]);
	terminal.input("\x1b[<0;1;1M");
	terminal.input("\x1b[<32;5;1M");
	terminal.input("\x1b[<0;5;1m");
	await vi.waitFor(() => expect(copied).toEqual(["alpha"]));
});

test("clicking a hyperlink calls the application URL handler without copying its label", async () => {
	const opened: string[] = [],
		copied: string[] = [];
	const { ui, terminal } = setup(hyperlink("Read guide", "https://docs.example.test/guide"), {
		openUrl: (url) => opened.push(url),
		copySelection: async (text) => {
			copied.push(text);
			return true;
		},
	});
	ui.start();
	await vi.waitFor(async () => expect((await terminal.screen())[0]).toBe("Read guide"));
	terminal.input("\x1b[<0;3;1M");
	terminal.input("\x1b[<0;3;1m");
	expect(opened).toEqual(["https://docs.example.test/guide"]);
	expect(ui.hasActiveSelection()).toBe(false);
	expect(copied).toEqual([]);
});

test("scrollbar track clicks and thumb dragging repaint the selected document rows", async () => {
	const { ui, terminal, transcript } = setup(rows);
	const view = new ScrollView(transcript, { primary: true, scrollbar: "always" });
	ui.setLayoutRoot(view);
	ui.start();
	await vi.waitFor(() => expect(view.viewportHeight).toBe(8));
	terminal.input("\x1b[<0;24;8M");
	await vi.waitFor(() => expect(view.scrollTop).toBe(22));
	terminal.input("\x1b[<32;24;1M");
	await vi.waitFor(() => expect(view.scrollTop).toBe(0));
	terminal.input("\x1b[<0;24;1m");
	expect((await terminal.screen())[0]).toContain("row1");
	expect(ui.hasActiveSelection()).toBe(false);
});

test("repeated clicks select a joined path and then the entire line", async () => {
	const copied: string[] = [];
	const { ui, terminal } = setup("open src/main-file now", {
		copyOnSelect: false,
		copySelection: async (text) => {
			copied.push(text);
			return true;
		},
	});
	ui.start();
	await vi.waitFor(async () => expect((await terminal.screen())[0]).toBe("open src/main-file now"));
	const click = () => {
		terminal.input("\x1b[<0;7;1M");
		terminal.input("\x1b[<0;7;1m");
	};
	click();
	click();
	expect(await ui.copyActiveSelectionToClipboard()).toBe(true);
	expect(copied).toEqual(["src/main-file"]);
	click();
	expect(await ui.copyActiveSelectionToClipboard()).toBe(true);
	expect(copied).toEqual(["src/main-file", "open src/main-file now"]);
});

test("backward selection includes whole wide and emoji graphemes", async () => {
	const copied: string[] = [];
	const { ui, terminal } = setup("a界🙂b", {
		copyOnSelect: false,
		copySelection: async (text) => {
			copied.push(text);
			return true;
		},
	});
	ui.start();
	await vi.waitFor(async () => expect((await terminal.screen())[0]).toBe("a界🙂b"));
	terminal.input("\x1b[<0;5;1M");
	terminal.input("\x1b[<32;2;1M");
	terminal.input("\x1b[<0;2;1m");
	expect(await ui.copyActiveSelectionToClipboard()).toBe(true);
	expect(copied).toEqual(["界🙂"]);
});

for (const failure of [false, "Clipboard disabled", new Error("Clipboard busy")])
	test(`clipboard failure ${String(failure)} reaches the caller or rendered terminal`, async () => {
		const copied: string[] = [];
		const { ui, terminal } = setup("Select this", {
			copyOnSelect: false,
			copySelection: async (text) => {
				copied.push(text);
				if (failure instanceof Error) throw failure;
				return failure;
			},
		});
		ui.start();
		await vi.waitFor(async () => expect((await terminal.screen())[0]).toBe("Select this"));
		terminal.input("\x1b[<0;1;1M");
		terminal.input("\x1b[<32;6;1M");
		terminal.input("\x1b[<0;6;1m");
		if (failure instanceof Error) {
			await expect(ui.copyActiveSelectionToClipboard()).rejects.toBe(failure);
			expect(copied).toEqual(["Select"]);
			return;
		}
		expect(await ui.copyActiveSelectionToClipboard()).toBe(false);
		expect(copied).toEqual(["Select"]);
		const expected = typeof failure === "string" ? failure : "Copy failed";
		await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain(expected));
	});

test("temporary messages expire independently and reveal the underlying document", async () => {
	const { ui, terminal } = setup("Document still present");
	ui.start();
	await vi.waitFor(async () => expect((await terminal.screen())[0]).toBe("Document still present"));
	ui.flash("First notification", 200);
	ui.flash("Second notification", 1500);
	await vi.waitFor(async () => {
		const screen = (await terminal.screen()).join("\n");
		expect(screen).toContain("First notification");
		expect(screen).toContain("Second notification");
	});
	await vi.waitFor(async () => {
		const screen = (await terminal.screen()).join("\n");
		expect(screen).not.toContain("First notification");
		expect(screen).toContain("Second notification");
	});
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).not.toContain("Second notification"), {
		timeout: 2000,
	});
	expect((await terminal.screen())[0]).toBe("Document still present");
});

test("replacing an explicit layout root and returning to children redraws the active content", async () => {
	const { ui, terminal } = setup("Default content");
	ui.setLayoutRoot(new Text("Custom content", 0, 0));
	ui.start();
	await vi.waitFor(async () => expect((await terminal.screen())[0]).toBe("Custom content"));
	const root = new ScrollView(new Text(rows, 0, 0), { primary: true });
	ui.setLayoutRoot(root);
	await vi.waitFor(async () => expect((await terminal.screen())[0]).toContain("row1"));
	ui.scrollToBottom();
	await vi.waitFor(async () => expect((await terminal.screen())[0]).toContain("row23"));
	ui.setLayoutRoot(undefined);
	await vi.waitFor(async () => expect((await terminal.screen())[0]).toBe("Default content"));
});

test("fullscreen keeps constructor callbacks after the caller edits its options", async () => {
	const copied: string[] = [];
	let receiver: unknown;
	const options: TuiAltScreenOptions = {
		copyOnSelect: false,
		copySelection: async function (this: unknown, text) {
			receiver = this;
			copied.push(text);
			return true;
		},
	};
	const { ui, terminal } = setup("alpha beta", options);
	options.copySelection = async () => false;
	ui.start();
	ui.renderNow();
	terminal.input("\x1b[<0;1;1M");
	terminal.input("\x1b[<32;5;1M");
	terminal.input("\x1b[<0;5;1m");
	expect(await ui.copyActiveSelectionToClipboard()).toBe(true);
	expect(copied).toEqual(["alpha"]);
	expect(receiver).toBe(ui);
});

test("nonvertical SGR wheel codes still reach the component mouse handler", () => {
	const { ui, terminal } = setup("");
	const events: string[] = [];
	ui.addChild({
		render: () => ["target"],
		invalidate() {},
		handleMouse(event) {
			events.push(`${event.type}:${event.button}`);
			return { handled: true };
		},
	});
	ui.start();
	ui.renderNow();
	terminal.input("\x1b[<66;2;1M");
	expect(events).toEqual(["press:right"]);
});
