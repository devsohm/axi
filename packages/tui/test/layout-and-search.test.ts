import { expect, test, vi, afterEach } from "vitest";
import { AltScreenSearchIndex, findAltScreenSearchMatches } from "../src/alt-screen-search.ts";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import { VStack } from "../src/components/v-stack.ts";
import { getLayoutBoxesAt, getScrollViewsAt, renderLayoutFrame } from "../src/layout.ts";
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

test("scroll targeting prefers the deepest view independently of paint layers", () => {
	const inner = new ScrollView(new Text("content", 0, 0));
	const outer = new ScrollView(inner);
	const frame = renderLayoutFrame(outer, 12, 3, () => {});
	frame.root.layer = 10;
	expect(getLayoutBoxesAt(frame, 0, 0)[0]?.scrollView).toBe(outer);
	expect(getScrollViewsAt(frame, 0, 0)).toEqual([inner, outer]);
});

test("a scrolled image remains visible through decorated placeholder lines", async () => {
	const { encodeKitty, registerKittyImageMetadata } = await import("../src/terminal-image.ts");
	const imageId = 984312;
	registerKittyImageMetadata({ imageId, columns: 2, rows: 3, widthPx: 90, heightPx: 90 });
	const image = encodeKitty("AAAA", { imageId, columns: 2, rows: 3, moveCursor: false });
	const content = { render: () => ["heading", image, " | details", " | details", "tail", "end"], invalidate() {} };
	const view = new ScrollView(content, { follow: "end", primary: true });
	const frame = renderLayoutFrame(view, 20, 3, () => {});
	expect(view.scrollTop).toBe(3);
	expect(frame.lines[0]).toContain("i=984312");
	expect(frame.lines[0]).toContain("y=60,h=30,r=1");
});
