import { afterEach, expect, test, vi } from "vitest";
import { Input } from "../src/components/input.ts";
import { Text } from "../src/components/text.ts";
import { VStack } from "../src/components/v-stack.ts";
import { ScrollView } from "../src/components/scroll-view.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { TestTerminal } from "./support/terminal.ts";
import { encodeKitty, registerKittyImageMetadata, resetCapabilitiesCache, setCapabilities } from "../src/terminal-image.ts";

const resources: { ui: TuiMainScreen | TuiAltScreen; terminal: TestTerminal }[] = [];
afterEach(() => {
	for (const { ui, terminal } of resources.splice(0)) {
		ui.stop();
		terminal.dispose();
	}
});

test("fullscreen image placements follow clears and later writes on every terminal", async () => {
	vi.stubEnv("WEZTERM_PANE", undefined);
	vi.stubEnv("TERM_PROGRAM", "test-terminal");
	setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
	const terminal = new TestTerminal(24, 6), writes: string[] = [];
	const write = terminal.write.bind(terminal);
	terminal.write = (value) => {
		writes.push(value);
		write(value);
	};
	const imageId = 82001;
	registerKittyImageMetadata({ imageId, columns: 2, rows: 3, widthPx: 20, heightPx: 60 });
	const lines = [
		"heading",
		encodeKitty("AQ==", { imageId, columns: 2, rows: 3, moveCursor: false }),
		"", "", "", "footer",
	];
	const ui = new TuiAltScreen(terminal);
	try {
		ui.setLayoutRoot({ render: () => lines, invalidate() {} });
		ui.start();
		ui.renderNow();
		await terminal.screen();
		const first = writes.join("");
		expect(first.indexOf("\x1b_Ga=T")).toBeGreaterThan(first.lastIndexOf("\x1b[6;1H\x1b[2K"));
		expect(first.indexOf("\x1b_Ga=T")).toBeGreaterThan(first.indexOf("footer"));
		writes.length = 0;
		lines[2] = "streaming row";
		ui.renderNow();
		await terminal.screen();
		const changed = writes.join("");
		expect(changed.indexOf("\x1b_Ga=p")).toBeGreaterThan(changed.indexOf("streaming row"));
		writes.length = 0;
		terminal.resize(24, 8);
		ui.renderNow();
		const screen = await terminal.screen(), resized = writes.join("");
		expect(resized).toContain("\x1b_Ga=p");
		expect(resized).not.toContain("\x1b_Ga=T");
		expect(resized).not.toContain("\x1b[2J");
		expect(screen[5]).toBe("footer");
		expect(screen.slice(6)).toEqual(["", ""]);
	} finally {
		ui.stop();
		terminal.dispose();
		resetCapabilitiesCache();
		vi.unstubAllEnvs();
	}
});

test("percentage overlay positions retain ratio rounding at cell boundaries", () => {
	for (const [extent, percentage, position] of [
		[51, 58, 28],
		[101, 29, 28],
		[101, 57, 56],
		[101, 58, 57],
	] as const) {
		const terminal = new TestTerminal(extent, extent),
			ui = new TuiMainScreen(terminal);
		resources.push({ ui, terminal });
		const overlay = ui.showOverlay(new Text("x", 0, 0), {
			width: 1,
			row: `${percentage}%`,
			col: `${percentage}%`,
		});
		ui.renderNow();
		expect(overlay.getBounds()).toEqual({ row: position, col: position, width: 1, height: 1 });
	}
});

test("scrollback rendering edits focused input, restores focus after overlays and clears removed content", async () => {
	const terminal = new TestTerminal(30, 8),
		ui = new TuiMainScreen(terminal);
	resources.push({ ui, terminal });
	const heading = new Text("Ready", 0, 0),
		input = new Input();
	ui.addChild(heading);
	ui.addChild(input);
	ui.setFocus(input);
	ui.start();
	terminal.input("a");
	terminal.input("b");
	await vi.waitFor(async () => expect((await terminal.screen()).slice(0, 2)).toEqual(["Ready", "> ab"]));
	const dialog = new Input();
	dialog.setValue("Dialog");
	const overlay = ui.showOverlay(dialog, { row: 2, col: 3, width: 12 });
	terminal.input("\x05");
	terminal.input("!");
	await vi.waitFor(async () => expect((await terminal.screen())[2]).toContain("Dialog!"));
	expect(input.getValue()).toBe("ab");
	overlay.hide();
	terminal.input("c");
	expect(input.getValue()).toBe("abc");
	ui.removeChild(heading);
	ui.requestRender();
	await vi.waitFor(async () => expect((await terminal.screen())[0]).toBe("> abc"));
	terminal.resize(12, 5);
	await vi.waitFor(async () => expect((await terminal.screen())[0]).toBe("> abc"));
	ui.stop();
	terminal.input("discarded");
	expect(input.getValue()).toBe("abc");
});

test("fullscreen layout follows new transcript rows until scrolling and restores the previous screen", async () => {
	const terminal = new TestTerminal(20, 5);
	terminal.write("original");
	await terminal.screen();
	const ui = new TuiAltScreen(terminal);
	resources.push({ ui, terminal });
	const transcript = new Text("one\ntwo\nthree\nfour\nfive\nsix", 0, 0);
	const scroll = new ScrollView(transcript, { primary: true, follow: "end" });
	ui.setLayoutRoot(
		new VStack([
			{ component: scroll, basis: 0, grow: 1 },
			{ component: new Text("prompt", 0, 0), basis: 1, shrink: 0 },
		]),
	);
	ui.start();
	await vi.waitFor(async () => expect(await terminal.screen()).toEqual(["three", "four", "five", "six", "prompt"]));
	scroll.scrollBy(-2);
	ui.requestRender();
	await vi.waitFor(async () => expect(await terminal.screen()).toEqual(["one", "two", "three", "four", "prompt"]));
	transcript.setText("one\ntwo\nthree\nfour\nfive\nsix\nseven");
	ui.requestRender();
	await vi.waitFor(async () => expect((await terminal.screen())[0]).toBe("one"));
	scroll.scrollToEnd();
	ui.requestRender();
	await vi.waitFor(async () => expect(await terminal.screen()).toEqual(["four", "five", "six", "seven", "prompt"]));
	ui.stop({ preserveScreen: true });
	expect((await terminal.screen())[0]).toBe("original");
});

test("a fullscreen mouse click focuses a nested input and listeners can transform or consume input", async () => {
	const terminal = new TestTerminal(20, 4),
		ui = new TuiAltScreen(terminal);
	resources.push({ ui, terminal });
	const input = new Input();
	input.setValue("hello");
	ui.setLayoutRoot(
		new VStack([
			{ component: new Text("title", 0, 0), basis: 1 },
			{ component: input, basis: 1 },
		]),
	);
	ui.start();
	await vi.waitFor(async () => expect((await terminal.screen())[1]).toBe("> hello"));
	terminal.input("\x1b[<0;5;2M");
	terminal.input("\x1b[<0;5;2m");
	terminal.input("!");
	expect(input.getValue()).toBe("he!llo");
	const remove = ui.addInputListener((data) =>
		data === "x" ? { data: "X" } : data === "z" ? { consume: true } : undefined,
	);
	terminal.input("x");
	terminal.input("z");
	expect(input.getValue()).toBe("he!Xllo");
	remove();
	terminal.input("x");
	expect(input.getValue()).toBe("he!Xxllo");
});

test("fullscreen search navigates matches and mouse selection copies transcript text", async () => {
	const terminal = new TestTerminal(50, 6),
		copied: string[] = [];
	const ui = new TuiAltScreen(terminal, undefined, undefined, {
		copySelection: async (text) => {
			copied.push(text);
			return true;
		},
	});
	resources.push({ ui, terminal });
	ui.addChild(new Text("alpha\nneedle one\nbravo\ncharlie\ndelta\necho\nfoxtrot\nneedle two\ngolf\nhotel", 0, 0));
	ui.start();
	await vi.waitFor(() => expect(ui.viewportTop).toBe(4));
	terminal.input("\x1b[102;6u");
	terminal.input("needle");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("2/2"));
	terminal.input("\r");
	await vi.waitFor(() => expect(ui.viewportTop).toBe(0));
	terminal.input("\r");
	await vi.waitFor(() => expect(ui.viewportTop).toBe(4));
	terminal.input("\x1b");
	terminal.input("\x1b[1;5H");
	await vi.waitFor(async () => expect((await terminal.screen())[0]).toBe("alpha"));
	terminal.input("\x1b[<0;1;1M");
	terminal.input("\x1b[<32;5;1M");
	terminal.input("\x1b[<0;5;1m");
	await vi.waitFor(() => expect(copied).toEqual(["alpha"]));
	ui.resetTextSelection();
	expect(ui.hasActiveSelection()).toBe(false);
});
