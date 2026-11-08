import { afterEach, expect, test, vi } from "vitest";
import {
	AltScreenSearchComponent,
	AltScreenSearchIndex,
	findAltScreenSearchMatches,
	getAltScreenSearchMatchKey,
} from "../src/alt-screen-search.ts";
import { Input } from "../src/components/input.ts";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import { VStack } from "../src/components/v-stack.ts";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "../src/keybindings.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { stripTerminalSequences, visibleWidth } from "../src/utils.ts";
import { TestTerminal } from "./support/terminal.ts";

afterEach(() => setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS)));

test("search treats query punctuation literally, folds whitespace and maps whole graphemes to terminal cells", () => {
	const lines = ["  \x1b[31mé\x1b[0m 👩‍💻", "界 🙂.*[", "end"];
	expect(findAltScreenSearchMatches(lines, "e")).toEqual([
		{ segments: [{ row: 0, startCol: 2, endCol: 3 }] },
		{ segments: [{ row: 2, startCol: 0, endCol: 1 }] },
	]);
	expect(findAltScreenSearchMatches(lines, "👩‍💻 \n\t 界")).toEqual([
		{
			segments: [
				{ row: 0, startCol: 4, endCol: 6 },
				{ row: 1, startCol: 0, endCol: 2 },
			],
		},
	]);
	expect(findAltScreenSearchMatches(lines, "🙂.*[")).toEqual([{ segments: [{ row: 1, startCol: 3, endCol: 8 }] }]);
	expect(findAltScreenSearchMatches(["end END end"], "end")).toHaveLength(3);
	expect(getAltScreenSearchMatchKey({ segments: [] })).toBe("");
	expect(getAltScreenSearchMatchKey({ segments: [{ row: 1, startCol: 3, endCol: 8 }] })).toBe("1:3:1:8");
	const index = new AltScreenSearchIndex();
	expect(index.search(lines, "").matches).toEqual([]);
	expect(index.search(lines, "end").matches).toHaveLength(1);
	expect(index.search([...lines], " end ").changed).toBe(false);
	expect(index.search(["changed"], "end")).toMatchObject({ changed: true, matches: [] });
});

test("search controls fit narrow terminals, report results and expose only their painted navigation targets", () => {
	const queries: string[] = [];
	const styling: { text: string; hovered: boolean }[] = [];
	const search = new AltScreenSearchComponent(
		(query) => queries.push(query),
		(text, hovered) => {
			styling.push({ text, hovered });
			return text;
		},
	);
	search.focused = true;
	expect(search.focused).toBe(true);
	expect(search.render(40).map(stripTerminalSequences).join("\n")).toContain("Find in transcript");
	search.handleInput("needle");
	search.handleInput("\x1b[D");
	expect(queries).toEqual(["needle"]);
	expect(search.render(40).map(stripTerminalSequences).join("\n")).toContain("No matches");
	search.setResult(1, 3);
	expect(search.render(40).map(stripTerminalSequences).join("\n")).toContain("2/3");
	for (const width of [1, 2, 3, 6, 8, 12, 40, 100]) {
		styling.length = 0;
		const frame = search.render(width).map(stripTerminalSequences);
		expect(frame).toHaveLength(3);
		for (const line of frame) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		for (let column = 0; column < width; column++) {
			expect(search.getNavigationDirectionAt(1, column)).toBeUndefined();
			const direction = search.getNavigationDirectionAt(2, column);
			if (direction !== undefined) expect(frame[2]).toContain(direction < 0 ? "↑" : "↓");
		}
	}
	expect(search.setHoveredNavigationDirection(-1)).toBe(true);
	expect(search.setHoveredNavigationDirection(-1)).toBe(false);
	search.render(100);
	expect(styling).toContainEqual(expect.objectContaining({ text: expect.stringContaining("↑"), hovered: true }));
	expect(search.setHoveredNavigationDirection(undefined)).toBe(true);
	search.invalidate();
	search.focused = false;
	expect(search.focused).toBe(false);
});

test("fullscreen search wraps results, keeps draft input separate and survives transcript updates and resize", async () => {
	setKeybindings(
		new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.altScreen.search": "ctrl+f",
			"tui.altScreen.searchPrevious": "ctrl+p",
		}),
	);
	const terminal = new TestTerminal(64, 12),
		ui = new TuiAltScreen(terminal);
	const text = Array.from({ length: 40 }, (_, index) => (index % 12 === 2 ? `needle ${index}` : `row ${index}`)).join(
		"\n",
	);
	const transcript = new Text(text, 0, 0),
		input = new Input();
	const scroll = new ScrollView(transcript, { follow: "end", primary: true });
	ui.setLayoutRoot(
		new VStack([
			{ component: scroll, basis: 0, grow: 1 },
			{ component: input, basis: 1, shrink: 0 },
		]),
	);
	ui.setFocus(input);
	const screen = async () => (await terminal.screen()).join("\n");
	try {
		ui.start();
		await vi.waitFor(() => expect(ui.viewportTop).toBeGreaterThan(20));
		terminal.input("\x06");
		terminal.input("needle");
		await vi.waitFor(async () => expect(await screen()).toContain("4/4"));
		expect(input.getValue()).toBe("");
		terminal.input("\r");
		await vi.waitFor(async () => expect(await screen()).toContain("1/4"));
		expect(ui.viewportTop).toBeLessThan(10);
		terminal.input("\x10");
		await vi.waitFor(async () => expect(await screen()).toContain("4/4"));
		transcript.setText(text + "\nneedle appended");
		ui.requestRender();
		await vi.waitFor(async () => expect(await screen()).toContain("4/5"));
		terminal.resize(38, 10);
		await vi.waitFor(async () => expect(await screen()).toContain("4/5"));
		terminal.input("\x1b");
		terminal.input("draft");
		expect(input.getValue()).toBe("draft");
		await vi.waitFor(async () => expect(await screen()).not.toContain("4/5"));
	} finally {
		ui.stop();
		terminal.dispose();
	}
});
