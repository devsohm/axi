import { expect, test, vi, afterEach } from "vitest";
import { AltScreenSearchIndex, findAltScreenSearchMatches } from "../src/alt-screen-search.ts";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import { VStack } from "../src/components/v-stack.ts";
import { renderLayoutFrame } from "../src/layout.ts";
import { stripTerminalSequences } from "../src/utils.ts";
import { AltScreenFlashContainer } from "../src/components/alt-screen-flash.ts";

afterEach(() => vi.useRealTimers());

test("a fixed dock stays below a growing, scrollable transcript", () => {
	const body = new Text("one\ntwo\nthree\nfour", 0, 0);
	const scroll = new ScrollView(body, { follow: "end", primary: true });
	const root = new VStack([
		{ component: scroll, basis: 0, grow: 1 },
		{ component: new Text("input", 0, 0), basis: 1, shrink: 0 },
	]);
	const frame = () =>
		renderLayoutFrame(root, 8, 3, () => {}).lines.map((line) => stripTerminalSequences(line).trimEnd());
	expect(frame()).toEqual(["three", "four", "input"]);
	scroll.scrollBy(-1);
	body.setText("one\ntwo\nthree\nfour\nfive");
	expect(frame()).toEqual(["two", "three", "input"]);
	scroll.scrollToEnd();
	expect(frame()).toEqual(["four", "five", "input"]);
});

test("transcript search maps normalized text to Unicode terminal cells and reuses unchanged results", () => {
	const lines = ["before 界", "🙂 after"];
	expect(findAltScreenSearchMatches(lines, "界 🙂")).toEqual([
		{
			segments: [
				{ row: 0, startCol: 7, endCol: 9 },
				{ row: 1, startCol: 0, endCol: 2 },
			],
		},
	]);
	const index = new AltScreenSearchIndex();
	const first = index.search(lines, "after");
	const second = index.search([...lines], "after");
	expect(second.changed).toBe(false);
	expect(second.matches).toBe(first.matches);
	expect(index.search(["changed"], "after").matches).toEqual([]);
});

test("flash expiry removes only the expired message and disposal cancels timers", () => {
	vi.useFakeTimers();
	const redraw = vi.fn(),
		flashes = new AltScreenFlashContainer(redraw);
	flashes.flash("first", 10);
	flashes.flash("second", 20);
	vi.advanceTimersByTime(10);
	expect(flashes.render(12).map(stripTerminalSequences)).toEqual([" second "]);
	flashes.dispose();
	const calls = redraw.mock.calls.length;
	vi.advanceTimersByTime(50);
	expect(flashes.render(12)).toEqual([]);
	expect(redraw).toHaveBeenCalledTimes(calls);
});
